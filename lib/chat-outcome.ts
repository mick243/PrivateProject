/**
 * 챗봇 탐색 결과를 사람이 읽을 한 덩어리로 (components/ChatBot.tsx 의 말풍선).
 *
 * 컴포넌트 안에 있던 것을 떼어 왔습니다 — 2026-10-22 첫 사용자 점검에서 이 말풍선이
 * 두 가지로 틀렸고(문장의 "사볼" 을 말없이 버림 · "75점" 의 뜻을 말하지 않음), 그 둘을
 * 테스트로 못 박으려면 순수 함수여야 합니다.
 *
 * 순수 함수만 둡니다 — 클라이언트 번들에 들어갑니다.
 */

import type { SearchOutcome } from './chat-types';
import { describeOrder, describeScoring, type PriorityOrder } from './recommend';

export function formatOutcome(outcome: SearchOutcome, order: PriorityOrder): string {
  const { total, radiusKm, hasOrigin, top, machineNames } = outcome;

  if (total === 0) {
    // 그 기종을 등록한 곳이 아예 없다 — 반경을 넓혀도 0곳이다. 조용히 "조건에 맞는 곳이
    // 없다" 고만 하면 기종 조건이 먹었는지조차 알 수 없다.
    if (outcome.machineUnregistered && machineNames.length > 0) {
      return [
        `${machineNames.join('·')} 보유로 등록된 오락실이 아직 없습니다.`,
        '보유 기종은 다녀온 사람들의 제보로 채워집니다. 가 본 오락실을 열고 "기종 선택 → 제보" 로 알려 주시면 다음부터 찾아 드릴 수 있어요.',
        '기종 없이 가까운 곳을 보려면 "오락실 찾아줘" 라고만 적어 주세요.',
      ].join('\n');
    }
    // radiusKm 0 = 반경 전체 — "반경을 넓혀라" 는 답이 될 수 없다.
    return hasOrigin && radiusKm > 0
      ? `반경 ${radiusKm}km 안에 조건에 맞는 오락실이 없습니다. 반경을 넓히거나 기종 필터를 풀어 보세요.`
      : '조건에 맞는 오락실이 없습니다. 검색어나 기종 필터를 풀어 보세요.';
  }

  const scope = hasOrigin
    ? radiusKm > 0
      ? `반경 ${radiusKm}km 안 ${total}곳`
      : `기준점에서 가까운 순으로 ${total}곳`
    : `등록된 ${total}곳`;
  const filter = machineNames.length ? ` (${machineNames.join('·')} 보유)` : '';

  const lines = [
    `탐색이 완료되었습니다. ${describeOrder(order)} 기준으로 ${scope}${filter}을 비교해 지도와 목록에 표시했습니다.`,
    // 그곳이 목록에 왜 없는지를 여기서 밝히지 않으면 빠진 것이 버그로 보입니다.
    ...(outcome.excluded
      ? [`${outcome.excluded}을(를) 기준점으로 잡았고, 그곳은 결과에서 뺐습니다.`]
      : []),
    '',
    ...top.map((t, i) => {
      // 비어 있던 항목을 이유 옆에 붙인다 — "75점" 이 대기·컨디션까지 따진 점수로 읽히지 않게.
      const why = t.missing.length ? `${t.reason} · ${t.missing.join('·')} 정보 없음` : t.reason;
      return `${i + 1}위 ${t.name} — ${t.score}점${t.distanceLabel ? ` · ${t.distanceLabel}` : ''} (${why})`;
    }),
    '',
    describeScoring(),
  ];

  if (!hasOrigin) {
    // "거리는 빼고" 가 아니다 — 모든 곳이 거리 몫의 절반을 똑같이 받아 거리로는 갈리지 않을 뿐이다.
    // 바로 위 점수 설명과 말이 어긋나지 않게 그 사실대로 적는다.
    lines.push('', '기준점이 없어 거리로는 가르지 못했습니다. 지도 왼쪽 아래 내 위치 단추를 켜면 다시 매깁니다.');
  }

  if (outcome.stale) {
    // 이 말풍선은 그 순간의 스냅샷이고 목록은 계속 갱신된다. 조회가 아직
    // 끝나지 않았으면 둘의 개수가 곧 어긋나므로 미리 적어 둔다.
    lines.push('', '목록을 아직 불러오는 중이라 결과가 더 늘 수 있습니다.');
  }

  return lines.join('\n');
}
