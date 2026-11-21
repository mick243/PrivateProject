/**
 * 도우미가 쓰는 **기준 위치** — 내 위치, 없으면 지도 가운데 (2026-11-20 UX 시험 B-3).
 *
 * 예전에는 파인더가 붙잡아 둔 기준(직전에 찾은 '홍대')을 그대로 썼습니다. 위치를 허용해
 * 두었는데도 '근처 펌프' 가 홍대 기준으로 나왔고, 말풍선에는 그 사실이 없었습니다.
 *
 * 브라우저 API 를 만지므로 클라이언트 전용입니다. 위치를 못 얻으면 이유를 사람 말로 돌려줍니다.
 */

import type { MentionedPlace } from './query-constraints';

/** 파인더가 지도 화면을 적어 두는 자리 (components/ArcadeFinder.tsx MAP_VIEW_STORE_KEY) */
const MAP_VIEW_STORE_KEY = 'arcade-finder:map';

export const MY_LOCATION_NAME = '내 위치';
export const MAP_CENTER_NAME = '지금 지도 가운데';

export type LocateResult = { ok: true; place: MentionedPlace } | { ok: false; reason: string };

/**
 * 위치 권한이 **이미 허용**돼 있는지. 묻지 않고 알 수 있을 때만 true —
 * 'near' 라고 말하지 않은 문장('펌프')에서 갑자기 권한 창을 띄우지 않으려고 씁니다.
 */
export async function locationGranted(): Promise<boolean> {
  try {
    const status = await navigator.permissions?.query({ name: 'geolocation' as PermissionName });
    return status?.state === 'granted';
  } catch {
    return false;
  }
}

/** 지금 내 위치 한 번. 권한을 묻는 창이 뜰 수 있습니다 */
export function currentPosition(timeoutMs = 8000): Promise<LocateResult> {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      resolve({ ok: false, reason: '이 브라우저에서는 내 위치를 쓸 수 없어요' });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          ok: true,
          place: { name: MY_LOCATION_NAME, lat: pos.coords.latitude, lng: pos.coords.longitude },
        }),
      (err) =>
        resolve({
          ok: false,
          reason:
            err.code === err.PERMISSION_DENIED
              ? '위치 사용이 막혀 있어요. 주소창의 자물쇠를 눌러 위치를 허용해 주세요'
              : '지금은 내 위치를 찾지 못했어요',
        }),
      { enableHighAccuracy: false, timeout: timeoutMs, maximumAge: 60_000 },
    );
  });
}

/** 파인더 지도가 마지막으로 보던 가운데. 없으면 null */
export function mapCenter(): MentionedPlace | null {
  try {
    const raw = JSON.parse(sessionStorage.getItem(MAP_VIEW_STORE_KEY) ?? 'null') as {
      lat?: unknown;
      lng?: unknown;
    } | null;
    if (raw && typeof raw.lat === 'number' && typeof raw.lng === 'number') {
      return { name: MAP_CENTER_NAME, lat: raw.lat, lng: raw.lng };
    }
  } catch {
    // 저장소가 막혀 있으면 지도 가운데도 모른다
  }
  return null;
}
