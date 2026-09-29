import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * 네이버 지도 SDK 로더 — 인증 실패가 **로드가 끝난 뒤에** 오는 경우.
 *
 * NCP 에 등록되지 않은 도메인(예: localhost:3000 이 아닌 포트)에서 SDK 는 스크립트를
 * 200 으로 주고 naver.maps 도 채운 채 onload 를 부른다. 인증 요청이 401 로 돌아오면
 * 1초 뒤 `naver.maps = null` 로 비우고 나서 `navermap_authFailure` 를 부른다.
 * 예전 로더는 약속이 이미 끝났다며 그 콜백을 흘려서 MapPane 이 FallbackMap 으로 가지
 * 못했고, 뒤이어 도는 NaverMap effect 가 `naver.maps.Point` 에서 터졌다.
 *
 * 노드 환경이라 window · document 를 최소한으로만 흉내 낸다. SDK 스크립트는 head 에
 * 붙는 순간을 가로채 onload 를 직접 부른다.
 */

type FakeScript = { src: string; onload?: () => void; onerror?: () => void };
type FakeWindow = { naver?: { maps: unknown }; navermap_authFailure?: () => void };

let win: FakeWindow;
let injected: FakeScript[];

async function freshLoader() {
  vi.resetModules();
  return import('@/lib/naver-loader');
}

/** SDK 스크립트가 받아졌을 때 — naver.maps 를 채우고 onload */
function sdkLoads(script: FakeScript) {
  win.naver = { maps: { Point: class {} } };
  script.onload?.();
}

/** SDK 의 인증 실패 처리 그대로 — 네임스페이스를 비우고 나서 콜백 */
function sdkAuthFails() {
  win.naver!.maps = null;
  win.navermap_authFailure?.();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv('NEXT_PUBLIC_NAVER_MAP_KEY_ID', 'test-key');
  win = {};
  injected = [];
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', {
    createElement: () => ({ src: '' }) as FakeScript,
    head: { appendChild: (s: FakeScript) => injected.push(s) },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('loadNaverMaps — 인증 실패', () => {
  it('로드 뒤에 온 인증 실패를 구독자에게 알리고, 그 뒤로는 SDK 를 못 쓴다고 답한다', async () => {
    const { loadNaverMaps, naverMapsUsable, onNaverAuthFailure, NaverMapsLoadError } =
      await freshLoader();

    const loading = loadNaverMaps();
    expect(injected).toHaveLength(1);
    sdkLoads(injected[0]);
    await vi.runAllTimersAsync();
    await expect(loading).resolves.toBe(win.naver);
    expect(naverMapsUsable()).toBe(true);

    const listener = vi.fn();
    onNaverAuthFailure(listener);
    sdkAuthFails();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toBeInstanceOf(NaverMapsLoadError);
    expect(naverMapsUsable()).toBe(false);
  });

  it('인증 실패 뒤에 다시 부르면 스크립트를 또 붙이지 않고 곧바로 거절한다', async () => {
    const { loadNaverMaps, onNaverAuthFailure } = await freshLoader();

    const loading = loadNaverMaps();
    sdkLoads(injected[0]);
    await vi.runAllTimersAsync();
    await loading;
    sdkAuthFails();

    // 다른 화면에 갔다 돌아와 MapPane 이 NaverMap 을 다시 띄운 경우
    await expect(loadNaverMaps()).rejects.toThrow('인증 실패');
    expect(injected).toHaveLength(1);

    // 늦게 구독한 쪽도 바로 듣는다
    const late = vi.fn();
    onNaverAuthFailure(late);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('구독을 풀면 알리지 않는다 (지도가 이미 내려간 경우)', async () => {
    const { loadNaverMaps, onNaverAuthFailure } = await freshLoader();

    const loading = loadNaverMaps();
    sdkLoads(injected[0]);
    await vi.runAllTimersAsync();
    await loading;

    const listener = vi.fn();
    const unsubscribe = onNaverAuthFailure(listener);
    unsubscribe();
    sdkAuthFails();

    expect(listener).not.toHaveBeenCalled();
  });

  it('로드가 끝나기 전에 온 인증 실패는 약속을 거절한다 (예전 동작 유지)', async () => {
    const { loadNaverMaps, naverMapsUsable } = await freshLoader();

    const loading = loadNaverMaps();
    win.navermap_authFailure?.();

    await expect(loading).rejects.toThrow('인증 실패');
    expect(naverMapsUsable()).toBe(false);
  });

  it('인증이 통과하면 SDK 를 쓸 수 있다', async () => {
    const { loadNaverMaps, naverMapsUsable } = await freshLoader();

    expect(naverMapsUsable()).toBe(false);
    const loading = loadNaverMaps();
    sdkLoads(injected[0]);
    await vi.runAllTimersAsync();
    await loading;

    expect(naverMapsUsable()).toBe(true);
  });
});
