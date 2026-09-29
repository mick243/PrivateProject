/**
 * 홈 배너(components/NewsHero.tsx)에 거는 **게임 공식 홈페이지** 목록.
 *
 * ─── 왜 소식이 아니라 링크인가 (2026-09-29 운영자 결정) ────────
 * 예전 배너는 공식 공지를 긁어 온 글(scripts/sync-news.mjs)을 보여 줬습니다. 그런데
 * 코나미 그룹 사이트 이용 안내는 글·사진의 무단 전재·공중송신을 금지하고, 안다미로도
 * 사이트의 권리가 자기에게 있다고 밝힙니다. 제목 한 줄조차 — eagate 소식은 제목이
 * 없어 본문 문장을 뽑아 썼습니다 — 약관에 걸릴 여지가 있었습니다. 그래서 남의 글은
 * 옮기지 않고 **그 게임의 공식 홈페이지로 가는 링크만** 겁니다. 소식은 거기서 봅니다.
 *
 * ─── 주소를 고른 규칙 ──────────────────────────────────────
 * · 버전이 붙지 않은 입구를 씁니다. eagate 의 `/game/<게임>/` 은 그때그때의 최신판으로
 *   넘겨 주므로(sdvx → vii, 2dx → 34 …), 새 버전이 나와도 여기를 고칠 필요가 없습니다.
 * · 한국 가동판이 있는 게임은 그 판의 사이트를 씁니다 (maimai DX · CHUNITHM 은
 *   International ver.). 태고의 달인은 아시아판 사이트가 따로 없어 공식 포털을 씁니다.
 * · 2026-09-29 에 하나씩 열어 공식 사이트임을 확인했습니다.
 *
 * ─── 빠진 기종 ─────────────────────────────────────────────
 * EZ2AC · EZ2DJ 는 걸 곳이 없습니다. 공식 사이트였던 ez2ac.co.kr 은 도메인이 끊겼고
 * (Wix 404), ez2dj.com 은 주차된 도메인입니다. 새 공식 사이트가 생기면 여기에 더하세요.
 */

export interface GameSite {
  /** machines.name 과 같은 이름 — 화면의 다른 자리와 같은 표기를 씁니다 */
  name: string;
  /** machines.short_name — 배경색을 고르는 씨앗으로 씁니다 */
  shortName: string;
  url: string;
}

export const GAME_SITES: readonly GameSite[] = [
  { name: 'Pump It Up', shortName: '펌프', url: 'https://piugame.com/' },
  { name: 'SOUND VOLTEX', shortName: '사볼', url: 'https://p.eagate.573.jp/game/sdvx/' },
  { name: 'beatmania IIDX', shortName: 'IIDX', url: 'https://p.eagate.573.jp/game/2dx/' },
  { name: '太鼓の達人 (태고의 달인)', shortName: '태고', url: 'https://taiko-ch.net/' },
  { name: 'DanceDanceRevolution', shortName: 'DDR', url: 'https://p.eagate.573.jp/game/ddr/' },
  { name: 'maimai DX', shortName: 'maimai', url: 'https://maimai.sega.com/' },
  { name: 'CHUNITHM', shortName: '츄니즘', url: 'https://chunithm.sega.com/' },
  { name: 'jubeat', shortName: '유비트', url: 'https://p.eagate.573.jp/game/jubeat/' },
  { name: 'GITADORA', shortName: '기타도라', url: 'https://p.eagate.573.jp/game/gfdm/' },
  { name: 'DANCERUSH STARDOM', shortName: '댄스러쉬', url: 'https://p.eagate.573.jp/game/dan/' },
  { name: "pop'n music", shortName: '팝픈', url: 'https://p.eagate.573.jp/game/popn/' },
  { name: 'ノスタルジア (노스탤지어)', shortName: '노스탤지어', url: 'https://p.eagate.573.jp/game/nostalgia/' },
];

/** 배너에 작게 보여 줄 주소 — 어디로 가는 링크인지 누르기 전에 알 수 있게 */
export function hostOf(url: string): string {
  return new URL(url).host;
}
