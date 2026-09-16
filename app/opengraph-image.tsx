import { ImageResponse } from 'next/og';

export const runtime = 'nodejs';
export const alt = '오락실 파인더 — 내 주변 오락실 지도 · 리듬게임 커뮤니티';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

/**
 * 링크 미리보기 이미지. 파일을 두지 않고 그려서 내보내는 이유는 문구가 바뀔 때
 * 디자인 도구 없이 여기만 고치면 되기 때문입니다. 폰트는 시스템 기본(ImageResponse
 * 내장) — 한글은 Noto Sans 계열로 렌더됩니다.
 */
export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          padding: '80px 96px',
          background: 'linear-gradient(135deg, #0f1218 0%, #1b1f2e 100%)',
          color: '#e6e8ef',
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
          <div
            style={{
              width: 88,
              height: 88,
              borderRadius: 24,
              background: '#6d5efc',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 48,
            }}
          >
            📍
          </div>
          <div style={{ fontSize: 40, letterSpacing: 6, color: '#8b93a7' }}>ARCADE</div>
        </div>
        <div style={{ fontSize: 92, fontWeight: 700, marginTop: 40, lineHeight: 1.1 }}>오락실 파인더</div>
        <div style={{ fontSize: 40, marginTop: 28, color: '#b8bfd0' }}>
          내 주변 오락실 지도 · 보유 기종 · 실시간 제보 · 리듬게임 서열표
        </div>
      </div>
    ),
    size,
  );
}
