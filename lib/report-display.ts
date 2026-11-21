import { waitCountLabel, type MachineLive, type MachineReport, type PresenceOutcome, type ReportKind } from './community-types';

/**
 * 제보 결과를 화면에 옮기는 순수 함수들 (components/ArcadeDetailPanel.tsx · LiveBadge.tsx).
 *
 * lib/reports.ts 는 Prisma 를 부르므로 클라이언트 컴포넌트가 가져올 수 없다 — 그래서
 * 화면 쪽 계산은 여기 따로 둔다. 노드 환경 단위 테스트로 잡는다 (tests/report-display.test.ts).
 */

/**
 * 대기 뱃지에 붙일 시각 — **보이는 숫자를 알려 준 제보의 시각**.
 *
 * 뷰(machine_live)는 인원으로 최대값을, 시각으로 가장 최근 제보를 따로 고른다.
 * 그러면 10분 전 3명 + 방금 1명이 '3명 · 방금' 이 된다 (2026-11-20 UX 시험 R-2) —
 * 3명이 방금 확인된 값처럼 읽힌다. 상세는 최근 제보 목록을 이미 들고 있으므로
 * 그 안에서 같은 인원을 말한 가장 최근 제보를 찾아 그 시각을 쓴다.
 * 목록(20건)에 그 제보가 없으면 뷰의 시각으로 물러선다.
 *
 * 수명이 지난 대기 제보는 목록을 읽을 때 지워지므로(lib/reports.ts purgeExpiredQueueReports)
 * 목록 안의 대기 제보는 모두 뷰가 센 것과 같은 구간이다.
 */
export function waitShownAt(
  live: MachineLive | null,
  reports: readonly MachineReport[],
  machineId: number,
): string | null {
  if (!live || live.waitCount === null) return null;
  let best: string | null = null;
  for (const r of reports) {
    if (r.kind !== 'queue' || r.machineId !== machineId || r.waitCount !== live.waitCount) continue;
    if (best === null || new Date(r.createdAt).getTime() > new Date(best).getTime()) best = r.createdAt;
  }
  return best ?? live.waitReportedAt;
}

export interface ReportOutcomeInput {
  kind: ReportKind;
  /** 화면에 보이는 게임 이름 (줄임말) */
  machineName: string;
  /** 컨디션 제보면 몇 호기인지 */
  cabinetNo?: number | null;
  /** 대기 제보면 보낸 인원 */
  waitCount?: number | null;
  outcome: PresenceOutcome;
  support: number;
  need: number;
  /** 로그인하지 않고 보낸 제보 — 있어요/없어졌어요 반영 인원에 세지 않는다 */
  anonymous: boolean;
  /** 보낸 뒤 그 게임 뱃지에 뜨는 대기 값 (응답의 arcade 에서) */
  liveAfter?: MachineLive | null;
}

/**
 * 제보 뒤 한 줄. **어느 게임에 무엇을 보냈는지**를 먼저 말한다 — 결과가 카드에서
 * 떨어진 곳에 뜨던 때에는 무엇이 접수됐는지 알 수 없었다 (R-1).
 * "제보 1/3" 같은 분수 대신 남은 인원을 말한다 (docs/DESIGN-GUIDE.md §2-8).
 * 조사가 이름 받침에 따라 바뀌지 않도록 '<이름> 게임' 으로 쓴다.
 */
export function reportOutcomeMessage(p: ReportOutcomeInput): string {
  const game = `${p.machineName} 게임`;
  if (p.kind === 'queue') {
    const sent = p.waitCount ?? 0;
    // '12명+' 뒤에는 조사를 붙일 수 없어 '12명 이상' 으로 읽는다 (ArcadeDetailPanel waitSubmitLabel 과 같은 규칙)
    const label = sent === 0 ? '없음' : waitCountLabel(sent).replace(/\+$/, ' 이상');
    const head = `${p.machineName} 대기 ${label}으로 알렸어요.`;
    const shown = p.liveAfter?.waitCount ?? null;
    // 뱃지는 최근 제보 중 가장 많은 인원을 보여 준다(db/views.sql machine_live).
    // 방금 보낸 값보다 큰 숫자가 그대로 남으면 제보가 무시된 것처럼 보이므로 이유를 말한다.
    if (shown !== null && shown > sent) {
      return `${head} 최근 제보 중 가장 많은 인원(${waitCountLabel(shown)})을 보여 줘요`;
    }
    return `${head} 다음 사람이 바로 볼 수 있어요`;
  }
  if (p.kind === 'condition') {
    const which = p.cabinetNo != null ? `${p.cabinetNo}호기` : '기계';
    return `${p.machineName} ${which} 상태를 알렸어요. 다음 사람이 바로 볼 수 있어요`;
  }

  if (p.outcome === 'added') return `알려 줘서 고마워요! 이제 ${game}이 목록에 들어갔어요`;
  if (p.outcome === 'removed') return `알려 줘서 고마워요! ${game}이 목록에서 빠졌어요`;

  const head =
    p.kind === 'presence' ? `${game}이 있다고 알렸어요.` : `${game}이 없어졌다고 알렸어요.`;
  if (p.anonymous) return `${head} 로그인하지 않은 제보는 기록만 남고 목록은 바꾸지 않아요`;
  const left = Math.max(0, p.need - p.support);
  if (left === 0) return `${head} 알려 줘서 고마워요`;
  return p.kind === 'presence'
    ? `${head} ${left}명이 더 알려 주면 목록에 들어가요`
    : `${head} ${left}명이 더 알려 주면 목록에서 빠져요`;
}
