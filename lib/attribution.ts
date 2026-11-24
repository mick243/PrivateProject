/**
 * 화면에 밝히는 외부 자료의 출처.
 *
 * 보유 기종 일부는 나무위키 「오락실」 지역 문서를 정리해 넣습니다(2026-10-26 개발 DB ·
 * 수입 도구 scripts/import-namu-machines.ts 는 PR #25). 원문은 CC BY-NC-SA 2.0 KR 이라 **출처 · 라이선스 ·
 * 고쳤다는 사실**을 자료가 보이는 자리에 밝혀야 합니다. 비영리 조건(NC)이 있으니
 * 광고 · 유료 기능을 붙이기 전에 이 자료를 계속 쓸 수 있는지 먼저 봐야 합니다.
 *
 * 2026-11-24 부터는 줄마다 출처를 적습니다(migrate-085 — arcade_machines.source_* ·
 * arcades.hours_*). 상세 화면은 그 기종 바로 아래에 문서와 확인일을 보여 주고(영업시간 출처는 화면에 내지 않음)
 * (components/SourceNote.tsx), 보유 기종 영역 끝의 한 줄은 라이선스와 고쳤다는 사실을 밝힙니다.
 */
export const NAMU_ARCADE_URL = 'https://namu.wiki/w/%EC%98%A4%EB%9D%BD%EC%8B%A4';
export const CC_BY_NC_SA_KR_URL = 'https://creativecommons.org/licenses/by-nc-sa/2.0/kr/';

/** "2026-07-09" → "2026. 7. 9." — 화면에 쓰는 날짜 꼴 */
export function sourceDate(iso: string | null): string | null {
  const m = iso?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}. ${Number(m[2])}. ${Number(m[3])}.` : null;
}
