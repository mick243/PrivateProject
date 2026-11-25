import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ARCADE_INFO_KIND_LABEL,
  ARCADE_INFO_KINDS,
  infoFieldsOf,
  infoSentMessage,
} from '@/lib/arcade-info-report-types';
import { arcadeInfoReportInputSchema, arcadeInfoResolveSchema, formatIssues } from '@/lib/validation';

/**
 * 오락실 정보 고침 제보 (2026-11-25 · migrate-087).
 *
 * 이용자가 "정보가 달라요" 로 영업시간 · 문 닫음 · 옮김을 알리고, 관리자가 승인하면 영업시간만
 * 오락실에 들어갑니다. DB 는 대역으로 세웁니다 — 보려는 것은 받는 칸의 규칙과, 승인할 때 무엇을
 * 어디에 쓰는지입니다.
 */

const tx = {
  arcade_info_reports: { findFirst: vi.fn(), update: vi.fn(), create: vi.fn() },
  arcades: { update: vi.fn() },
};
vi.mock('@/lib/prisma', () => ({
  getPrismaClient: async () => ({
    ...tx,
    $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
  }),
}));

const { createInfoReport, currentHoursOf, meansAllDay, resolveInfoReport, USER_REPORT_SOURCE } = await import(
  '@/lib/arcade-info-reports'
);

beforeEach(() => {
  for (const fn of [
    tx.arcade_info_reports.findFirst,
    tx.arcade_info_reports.update,
    tx.arcade_info_reports.create,
    tx.arcades.update,
  ]) fn.mockReset();
});

describe('입력 규칙 (arcadeInfoReportInputSchema)', () => {
  const parse = (v: Record<string, unknown>) => arcadeInfoReportInputSchema.safeParse(v);

  it('영업시간 제보는 시간이 있어야 한다 — 없으면 예시와 함께 할 일을 알린다', () => {
    const r = parse({ kind: 'hours', hoursText: '  ' });
    expect(r.success).toBe(false);
    if (!r.success) expect(formatIssues(r.error).join(' ')).toContain('영업시간을 적어 주세요');
  });

  it('옮김 · 그 밖은 설명이 있어야 하고, 문 닫음은 설명 없이도 된다', () => {
    expect(parse({ kind: 'moved' }).success).toBe(false);
    expect(parse({ kind: 'other' }).success).toBe(false);
    expect(parse({ kind: 'closed' }).success).toBe(true);
    expect(parse({ kind: 'moved', detail: '같은 건물 2층' }).success).toBe(true);
  });

  it('종류에 맞지 않는 영업시간은 버린다 — DB CHECK 에 닿기 전에', () => {
    const r = parse({ kind: 'closed', hoursText: '10:00~22:00' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.hoursText).toBeNull();
  });

  it('길이 상한 (영업시간 200 · 설명 300)', () => {
    expect(parse({ kind: 'hours', hoursText: 'a'.repeat(201) }).success).toBe(false);
    expect(parse({ kind: 'closed', detail: 'a'.repeat(301) }).success).toBe(false);
  });

  it('모르는 종류는 받지 않는다', () => {
    expect(parse({ kind: 'phone', detail: 'x' }).success).toBe(false);
  });

  it('관리자 처리는 apply · dismiss 만', () => {
    expect(arcadeInfoResolveSchema.safeParse({ id: 1, action: 'apply' }).success).toBe(true);
    expect(arcadeInfoResolveSchema.safeParse({ id: 1, action: 'delete' }).success).toBe(false);
  });
});

describe('화면 문구', () => {
  it('고르는 칸은 전부 해요체이고 종류마다 하나씩', () => {
    for (const k of ARCADE_INFO_KINDS) expect(ARCADE_INFO_KIND_LABEL[k]).toMatch(/요$/);
  });

  it('보낸 뒤에는 바로 바뀌지 않는다는 것을 알린다', () => {
    expect(infoSentMessage('hours', false)).toContain('확인한 뒤');
    expect(infoSentMessage('closed', true)).toContain('고쳤어요');
  });

  it('종류마다 받는 칸', () => {
    expect(infoFieldsOf('hours')).toEqual({ hours: true, detail: 'optional' });
    expect(infoFieldsOf('closed')).toEqual({ hours: false, detail: 'optional' });
    expect(infoFieldsOf('moved').detail).toBe('required');
  });
});

describe('createInfoReport', () => {
  const input = { arcadeId: 5, playerId: 9, kind: 'hours' as const, hoursText: '매일 12:00~24:00', detail: null };

  it('처음이면 새 줄', async () => {
    tx.arcade_info_reports.findFirst.mockResolvedValue(null);
    tx.arcade_info_reports.create.mockResolvedValue({ id: 1 });
    expect(await createInfoReport(input)).toEqual({ id: 1, updated: false });
    expect(tx.arcade_info_reports.create.mock.calls[0][0].data).toMatchObject({
      arcade_id: 5,
      player_id: 9,
      kind: 'hours',
      hours_text: '매일 12:00~24:00',
    });
  });

  it('같은 사람 · 같은 오락실 · 같은 종류가 열려 있으면 그 줄을 고친다', async () => {
    tx.arcade_info_reports.findFirst.mockResolvedValue({ id: 3 });
    expect(await createInfoReport(input)).toEqual({ id: 3, updated: true });
    expect(tx.arcade_info_reports.create).not.toHaveBeenCalled();
    expect(tx.arcade_info_reports.findFirst.mock.calls[0][0].where).toEqual({
      player_id: 9,
      arcade_id: 5,
      kind: 'hours',
      status: 'open',
    });
  });
});

describe('resolveInfoReport', () => {
  it('영업시간을 승인하면 오락실에 넣고 출처를 이용자 제보로 남긴다 — 관리자가 다듬은 문장이 먼저', async () => {
    tx.arcade_info_reports.findFirst.mockResolvedValue({ arcade_id: 5, kind: 'hours', hours_text: '12시~24시' });
    expect(await resolveInfoReport({ id: 1, action: 'apply', adminId: 2, hoursText: '매일 12:00~24:00' })).toBe(true);
    const data = tx.arcades.update.mock.calls[0][0].data;
    expect(tx.arcades.update.mock.calls[0][0].where).toEqual({ id: 5 });
    expect(data).toMatchObject({
      hours_text: '매일 12:00~24:00',
      hours_source_title: USER_REPORT_SOURCE,
      hours_source_url: null,
      is_24h: false,
    });
    expect(data.hours_checked).toBeInstanceOf(Date);
    expect(tx.arcade_info_reports.update.mock.calls[0][0].data).toMatchObject({ status: 'applied', resolved_by: 2 });
  });

  it('"24시간" 이면 24시간 표시를 켠다', async () => {
    tx.arcade_info_reports.findFirst.mockResolvedValue({ arcade_id: 5, kind: 'hours', hours_text: '연중무휴 24시간' });
    await resolveInfoReport({ id: 1, action: 'apply', adminId: 2 });
    expect(tx.arcades.update.mock.calls[0][0].data.is_24h).toBe(true);
  });

  it('문 닫음은 승인해도 오락실을 건드리지 않는다 — 확인 표시만', async () => {
    tx.arcade_info_reports.findFirst.mockResolvedValue({ arcade_id: 5, kind: 'closed', hours_text: null });
    expect(await resolveInfoReport({ id: 1, action: 'apply', adminId: 2 })).toBe(true);
    expect(tx.arcades.update).not.toHaveBeenCalled();
    expect(tx.arcade_info_reports.update.mock.calls[0][0].data.status).toBe('applied');
  });

  it('버리면 오락실은 그대로', async () => {
    tx.arcade_info_reports.findFirst.mockResolvedValue({ arcade_id: 5, kind: 'hours', hours_text: 'x' });
    await resolveInfoReport({ id: 1, action: 'dismiss', adminId: 2 });
    expect(tx.arcades.update).not.toHaveBeenCalled();
    expect(tx.arcade_info_reports.update.mock.calls[0][0].data.status).toBe('dismissed');
  });

  it('열린 제보가 아니면 false', async () => {
    tx.arcade_info_reports.findFirst.mockResolvedValue(null);
    expect(await resolveInfoReport({ id: 1, action: 'apply', adminId: 2 })).toBe(false);
  });
});

describe('작은 판단들', () => {
  it('meansAllDay', () => {
    expect(meansAllDay('24시간')).toBe(true);
    expect(meansAllDay(' 24 시간 영업 ')).toBe(true);
    expect(meansAllDay('평일 24시간, 주말 10:00~')).toBe(false);
  });

  it('currentHoursOf — 상세 패널과 같은 순서', () => {
    const base = { is_24h: false, hours_text: null, open_time: null, close_time: null };
    expect(currentHoursOf({ ...base, is_24h: true, hours_text: 'x' })).toBe('24시간');
    expect(currentHoursOf({ ...base, hours_text: '월~토 10:00~22:00' })).toBe('월~토 10:00~22:00');
    expect(currentHoursOf({ ...base, open_time: '10:00', close_time: '22:00' })).toBe('10:00 ~ 22:00');
    expect(currentHoursOf(base)).toBeNull();
  });
});
