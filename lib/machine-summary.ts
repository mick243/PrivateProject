/**
 * 지도 이름표 옆에 붙이는 보유 기종 한 마디.
 *
 *   기종 필터 없음 → "13종"            (몇 종이 있는 곳인지)
 *   기종 필터 켬   → "사볼 2대"         (찾는 게임이 몇 대인지)
 *
 * 걸어온 길:
 *   1) 기종 **수**를 숫자만 붙였다 — "어뮤즈타운 0", "짱오락실 홍대점 1". 처음 온 사람은
 *      그 숫자가 대기 인원인지 순위인지 읽지 못했다 (2026-10-22 첫 사용자 점검).
 *   2) 이름을 앞에서 두 개 + "외 N" 으로 바꿨다 — "펌프 · 태고 외 11". 그런데 기종이 늘면
 *      알약이 길어져 옆 마커를 덮고, 앞의 두 개는 등록 순서일 뿐 고른 사람에게 의미가 없었다.
 *   3) 지금: 필터가 없으면 단위를 붙인 종 수만, 필터를 켜면 그 게임과 대수만. 알약이 늘
 *      짧고, 필터를 켠 사람의 질문("내 게임이 몇 대 있나")에 바로 답한다. 전체 목록은
 *      PC 에서 마우스를 올리면(machineTooltip), 폰에서는 이름표를 누르면(상세) 보인다.
 *
 * 등록된 기종이 없으면 null 입니다 — "0종" 은 정보가 아니라 잡음이고, 그 사실은 상세가
 * "아직 등록된 기종이 없습니다" 로 말합니다.
 *
 * 순수 함수만 둡니다 — 클라이언트 번들에 들어갑니다.
 */

/** 필터를 여럿 켰을 때 이름표에 이름으로 적을 기종 수. 이름표는 한 줄이라 길어지면 옆 마커를 덮습니다 */
export const MARKER_MACHINE_NAMES = 2;

interface NamedMachine {
  id: number;
  shortName: string;
  name: string;
  /** 대수. 없으면 1대로 봅니다 */
  cabinetCount?: number;
}

const label = (m: NamedMachine): string => m.shortName || m.name;
const cabinets = (m: NamedMachine): number => m.cabinetCount ?? 1;

/** 켜 둔 필터 중 이 오락실에 있는 기종 — 원래 순서대로 (고른 순서로 흔들리면 이름표가 깜빡입니다) */
function focused<T extends NamedMachine>(machines: readonly T[], focusIds: readonly number[]): T[] {
  if (focusIds.length === 0) return [];
  const focus = new Set(focusIds);
  return machines.filter((m) => focus.has(m.id));
}

export function machineSummary(
  machines: readonly NamedMachine[],
  focusIds: readonly number[] = [],
): string | null {
  if (machines.length === 0) return null;
  const hits = focused(machines, focusIds);
  // 필터가 없거나, 켜 둔 기종이 이 오락실에 없으면(선택해 둔 곳은 조건 밖이어도 지도에 남는다) 종 수.
  if (hits.length === 0) return `${machines.length}종`;
  const parts = hits.slice(0, MARKER_MACHINE_NAMES).map((m) => `${label(m)} ${cabinets(m)}대`);
  const rest = hits.length - MARKER_MACHINE_NAMES;
  return rest > 0 ? `${parts.join(' · ')} 외 ${rest}` : parts.join(' · ');
}

/**
 * 보유 기종 전부 — 마우스를 올리면 뜨는 설명(title)용. 켜 둔 기종이 앞입니다.
 *
 * 이름표가 이미 전부를 말하고 있으면(켜 둔 기종이 곧 그 오락실의 기종 전부면) 만들지
 * 않습니다 — 같은 말을 툴팁으로 한 번 더 띄우면 마우스가 지나갈 때마다 군더더기가
 * 따라다닙니다. 폰에는 툴팁이 없으므로 거기서는 이름표를 누르면 열리는 상세가 같은 일을 합니다.
 */
export function machineTooltip(
  machines: readonly NamedMachine[],
  focusIds: readonly number[] = [],
): string | null {
  if (machines.length === 0) return null;
  const hits = focused(machines, focusIds);
  if (hits.length === machines.length && hits.length <= MARKER_MACHINE_NAMES) return null;
  const hitIds = new Set(hits.map((m) => m.id));
  const ordered = [...hits, ...machines.filter((m) => !hitIds.has(m.id))];
  const parts = ordered.map((m) => (cabinets(m) > 1 ? `${label(m)} ×${cabinets(m)}` : label(m)));
  return `보유 기종 ${machines.length}종 — ${parts.join(' · ')}`;
}
