import type { ArcadeInfoKind, ArcadeInfoReportRow } from './arcade-info-report-types';
import { getPrismaClient } from './prisma';

/**
 * 오락실 정보 고침 제보 (db/migrate-087-arcade-info-reports.sql).
 *
 * 이용자가 상세에서 "정보가 달라요" 로 보내고, 관리자가 /admin 에서 정합니다. 바로 반영하지
 * 않는 이유는 영업시간은 틀리면 헛걸음이고, 문 닫음 · 옮김은 오락실을 지우거나 옮기는 일이라
 * 한 사람 말만으로 할 수 없어서입니다.
 *
 * ⚠ 서버 전용입니다 (getPrismaClient → pg).
 */

/** 승인한 영업시간의 출처 칸에 남기는 이름 (migrate-085 의 hours_source_title) */
export const USER_REPORT_SOURCE = '이용자 제보';

/**
 * 제보를 남깁니다. 같은 사람이 같은 오락실에 같은 종류를 열어 둔 것이 있으면 그 줄을 고칩니다
 * (DB 의 부분 유일 색인 arcade_info_reports_open_once). updated 는 고쳤는지 여부입니다.
 */
export async function createInfoReport(input: {
  arcadeId: number;
  playerId: number;
  kind: ArcadeInfoKind;
  hoursText: string | null;
  detail: string | null;
}): Promise<{ id: number; updated: boolean }> {
  const prisma = await getPrismaClient();
  const open = await prisma.arcade_info_reports.findFirst({
    where: { player_id: input.playerId, arcade_id: input.arcadeId, kind: input.kind, status: 'open' },
    select: { id: true },
  });
  if (open) {
    await prisma.arcade_info_reports.update({
      where: { id: open.id },
      data: { hours_text: input.hoursText, detail: input.detail, created_at: new Date() },
    });
    return { id: open.id, updated: true };
  }
  const row = await prisma.arcade_info_reports.create({
    data: {
      arcade_id: input.arcadeId,
      player_id: input.playerId,
      kind: input.kind,
      hours_text: input.hoursText,
      detail: input.detail,
    },
    select: { id: true },
  });
  return { id: row.id, updated: false };
}

/** 지금 화면에 보이는 영업시간 — 상세 패널과 같은 순서 (ArcadeDetailPanel) */
export function currentHoursOf(a: {
  is_24h: boolean;
  hours_text: string | null;
  open_time: string | null;
  close_time: string | null;
}): string | null {
  if (a.is_24h) return '24시간';
  if (a.hours_text) return a.hours_text;
  if (a.open_time && a.close_time) return `${a.open_time} ~ ${a.close_time}`;
  return null;
}

/** 관리자 검수 대기 목록 — 오래된 것부터 (먼저 온 것을 먼저 봅니다) */
export async function listInfoReportsForReview(): Promise<ArcadeInfoReportRow[]> {
  const prisma = await getPrismaClient();
  const rows = await prisma.arcade_info_reports.findMany({
    where: { status: 'open' },
    orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    take: 200,
    select: {
      id: true,
      arcade_id: true,
      kind: true,
      hours_text: true,
      detail: true,
      created_at: true,
      arcades: {
        select: { name: true, address: true, is_24h: true, hours_text: true, open_time: true, close_time: true },
      },
      reporter: { select: { nickname: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    arcadeId: r.arcade_id,
    arcadeName: r.arcades.name,
    address: r.arcades.address,
    currentHours: currentHoursOf(r.arcades),
    kind: r.kind as ArcadeInfoKind,
    hoursText: r.hours_text,
    detail: r.detail,
    nickname: r.reporter.nickname,
    createdAt: r.created_at.toISOString(),
  }));
}

/** "24시간" · "24 시간" · "연중무휴 24시간" 처럼 하루 종일 연다는 문장인지 */
export function meansAllDay(text: string): boolean {
  return /^(연중무휴\s*)?24\s*시간(\s*영업)?$/.test(text.trim());
}

/**
 * 제보를 정합니다.
 *
 * - apply · 영업시간: arcades.hours_text 에 넣고(관리자가 다듬은 문장이 있으면 그것), 출처 칸에
 *   '이용자 제보' 와 오늘 날짜를 남깁니다. 하루 종일이 아닌 문장이면 24시간 표시를 끕니다 —
 *   켜 둔 채면 상세가 '24시간' 을 먼저 보여서 고친 영업시간이 가려집니다.
 * - apply · 그 밖: 확인했다고만 표시합니다. 지우기 · 옮기기는 오락실 수정 화면에서 사람이 합니다.
 * - dismiss: 버립니다.
 *
 * 열린 제보가 아니면 false (이미 처리됐거나 없음).
 */
export async function resolveInfoReport(input: {
  id: number;
  action: 'apply' | 'dismiss';
  adminId: number;
  hoursText?: string | null;
}): Promise<boolean> {
  const prisma = await getPrismaClient();
  return prisma.$transaction(async (tx) => {
    const report = await tx.arcade_info_reports.findFirst({
      where: { id: input.id, status: 'open' },
      select: { arcade_id: true, kind: true, hours_text: true },
    });
    if (!report) return false;

    if (input.action === 'apply' && report.kind === 'hours') {
      const text = (input.hoursText ?? report.hours_text ?? '').trim();
      if (!text) return false;
      const today = new Date();
      await tx.arcades.update({
        where: { id: report.arcade_id },
        data: {
          hours_text: text,
          hours_source_title: USER_REPORT_SOURCE,
          hours_source_url: null,
          hours_checked: new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())),
          is_24h: meansAllDay(text),
          updated_at: today,
        },
      });
    }

    await tx.arcade_info_reports.update({
      where: { id: input.id },
      data: {
        status: input.action === 'apply' ? 'applied' : 'dismissed',
        resolved_at: new Date(),
        resolved_by: input.adminId,
      },
    });
    return true;
  });
}
