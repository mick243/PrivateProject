import { describe, expect, it } from 'vitest';
import type { MachineLive, MachineReport } from '@/lib/community-types';
import { reportOutcomeMessage, waitShownAt } from '@/lib/report-display';

function report(over: Partial<MachineReport>): MachineReport {
  return {
    id: 1,
    arcadeId: 1,
    arcadeName: '테스트 오락실',
    machineId: 10,
    machineName: 'SOUND VOLTEX',
    machineShortName: '사볼',
    cabinetId: null,
    cabinetNo: null,
    cabinetCount: 1,
    playerId: null,
    nickname: null,
    kind: 'queue',
    waitCount: 3,
    condition: null,
    comment: null,
    createdAt: '2026-11-20T10:00:00.000Z',
    ...over,
  };
}

const live = (waitCount: number | null, at = '2026-11-20T10:10:00.000Z'): MachineLive => ({
  waitCount,
  waitReports: 2,
  waitReportedAt: at,
});

describe('waitShownAt — 뱃지 시각은 보이는 숫자를 말한 제보의 시각 (R-2)', () => {
  it('최대값을 말한 옛 제보의 시각을 고른다 (방금 1명 · 10분 전 3명 → 10분 전)', () => {
    const reports = [
      report({ id: 2, waitCount: 1, createdAt: '2026-11-20T10:10:00.000Z' }),
      report({ id: 1, waitCount: 3, createdAt: '2026-11-20T10:00:00.000Z' }),
    ];
    expect(waitShownAt(live(3), reports, 10)).toBe('2026-11-20T10:00:00.000Z');
  });

  it('같은 인원이 여럿이면 가장 최근 것', () => {
    const reports = [
      report({ id: 1, waitCount: 3, createdAt: '2026-11-20T09:00:00.000Z' }),
      report({ id: 2, waitCount: 3, createdAt: '2026-11-20T09:30:00.000Z' }),
    ];
    expect(waitShownAt(live(3), reports, 10)).toBe('2026-11-20T09:30:00.000Z');
  });

  it('다른 게임 · 다른 종류는 보지 않고, 못 찾으면 뷰의 시각으로 물러선다', () => {
    const reports = [
      report({ machineId: 11, waitCount: 3 }),
      report({ kind: 'condition', waitCount: null, condition: 3 }),
    ];
    expect(waitShownAt(live(3), reports, 10)).toBe('2026-11-20T10:10:00.000Z');
  });

  it('대기 값이 없으면 null', () => {
    expect(waitShownAt(null, [], 10)).toBeNull();
    expect(waitShownAt(live(null), [], 10)).toBeNull();
  });
});

describe('reportOutcomeMessage — 어느 게임에 무엇을 보냈는지 말한다 (R-1 · R-2)', () => {
  const base = { machineName: '사볼', outcome: null, support: 0, need: 2, anonymous: false } as const;

  it('없어졌어요: 게임 이름과 남은 인원', () => {
    expect(reportOutcomeMessage({ ...base, kind: 'absence', support: 1 })).toBe(
      '사볼 게임이 없어졌다고 알렸어요. 1명이 더 알려 주면 목록에서 빠져요',
    );
  });

  it('없어졌어요가 반영되면 빠졌다고 말한다', () => {
    expect(reportOutcomeMessage({ ...base, kind: 'absence', outcome: 'removed', support: 2 })).toBe(
      '알려 줘서 고마워요! 사볼 게임이 목록에서 빠졌어요',
    );
  });

  it('익명 있어요/없어졌어요는 세지 않는다고 바로 알린다', () => {
    expect(reportOutcomeMessage({ ...base, kind: 'absence', anonymous: true })).toBe(
      '사볼 게임이 없어졌다고 알렸어요. 로그인하지 않은 제보는 기록만 남고 목록은 바꾸지 않아요',
    );
  });

  it('있어요가 반영되면 들어갔다고 말한다', () => {
    expect(reportOutcomeMessage({ ...base, kind: 'presence', outcome: 'added', support: 2 })).toBe(
      '알려 줘서 고마워요! 이제 사볼 게임이 목록에 들어갔어요',
    );
  });

  it('대기: 보낸 값보다 큰 값이 보이면 이유를 말한다', () => {
    expect(
      reportOutcomeMessage({ ...base, kind: 'queue', waitCount: 1, anonymous: true, liveAfter: live(3) }),
    ).toBe('사볼 대기 1명으로 알렸어요. 최근 제보 중 가장 많은 인원(3명)을 보여 줘요');
  });

  it('대기: 보낸 값이 보이면 그냥 고맙다고 · 12명+ 는 이상으로 읽는다', () => {
    expect(reportOutcomeMessage({ ...base, kind: 'queue', waitCount: 3, liveAfter: live(3) })).toBe(
      '사볼 대기 3명으로 알렸어요. 다음 사람이 바로 볼 수 있어요',
    );
    expect(reportOutcomeMessage({ ...base, kind: 'queue', waitCount: 13, liveAfter: live(13) })).toBe(
      '사볼 대기 12명 이상으로 알렸어요. 다음 사람이 바로 볼 수 있어요',
    );
    expect(reportOutcomeMessage({ ...base, kind: 'queue', waitCount: 0, liveAfter: live(0) })).toBe(
      '사볼 대기 없음으로 알렸어요. 다음 사람이 바로 볼 수 있어요',
    );
  });

  it('상태: 몇 호기인지 말한다', () => {
    expect(reportOutcomeMessage({ ...base, kind: 'condition', cabinetNo: 2 })).toBe(
      '사볼 2호기 상태를 알렸어요. 다음 사람이 바로 볼 수 있어요',
    );
  });
});
