import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import manifest from '@/app/manifest';

/**
 * 설치형 웹앱의 **설치 가능 조건**을 고정합니다.
 *
 * Chrome 이 "설치" 를 내주는 조건은 매니페스트 + 192·512 PNG 아이콘 + 서비스 워커 +
 * start_url 응답입니다. 어느 하나가 조용히 빠져도 화면은 멀쩡해서, 홈 화면에 추가가
 * 사라진 것을 사용자 말고는 아무도 못 봅니다.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** PNG 시그니처 + IHDR 의 가로·세로 */
function pngSize(file: string): { width: number; height: number } {
  const buf = fs.readFileSync(file);
  expect(buf.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe('manifest', () => {
  const m = manifest();

  it('standalone · 앱 안쪽 start_url · 한국어', () => {
    expect(m.display).toBe('standalone');
    expect(m.start_url?.startsWith('/')).toBe(true);
    expect(m.lang).toBe('ko');
    expect(m.name).toBe('오락실 파인더');
  });

  it('192·512 PNG 가 any 와 maskable 로 모두 있다 — Chrome 설치 조건', () => {
    const icons = m.icons ?? [];
    for (const purpose of ['any', 'maskable']) {
      for (const size of ['192x192', '512x512']) {
        expect(icons.some((i) => i.sizes === size && i.purpose === purpose && i.type === 'image/png')).toBe(true);
      }
    }
  });

  it('매니페스트가 가리키는 아이콘 파일이 public/ 에 실제로 있고 크기가 맞다', () => {
    for (const icon of m.icons ?? []) {
      const file = path.join(root, 'public', icon.src);
      expect(fs.existsSync(file), `${icon.src} 가 없습니다 — npm run pwa:icons`).toBe(true);
      const [w, h] = (icon.sizes ?? '').split('x').map(Number);
      expect(pngSize(file)).toEqual({ width: w, height: h });
    }
  });

  it('iOS 홈 화면 아이콘(app/apple-icon.png)이 180px 로 있다', () => {
    expect(pngSize(path.join(root, 'app/apple-icon.png'))).toEqual({ width: 180, height: 180 });
  });

  it('바로가기는 전부 앱 안쪽 경로다', () => {
    for (const s of m.shortcuts ?? []) expect(s.url.startsWith('/')).toBe(true);
  });
});

describe('service worker (public/sw.js)', () => {
  const sw = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');

  it('오프라인 화면을 미리 담고, 화면 이동 실패 시 그걸 돌려준다', () => {
    expect(sw).toMatch(/OFFLINE_URL = '\/offline'/);
    expect(sw).toMatch(/request\.mode === 'navigate'/);
    expect(fs.existsSync(path.join(root, 'app/offline/page.tsx'))).toBe(true);
  });

  it('/api/ 는 절대 캐시하지 않는다 — 대기 인원·내 클리어는 낡으면 틀린 값이다', () => {
    expect(sw).toMatch(/startsWith\('\/api\/'\)\) return/);
  });

  it('HTML 은 캐시하지 않는다 — 배포 뒤 옛 화면이 남지 않도록 (navigate 분기에 cache.put 이 없다)', () => {
    const navigate = /if \(request\.mode === 'navigate'\) \{[\s\S]*?\n  \}/.exec(sw)?.[0] ?? '';
    expect(navigate.length).toBeGreaterThan(0);
    expect(navigate).not.toMatch(/cache\.put|addAll/);
  });

  it('GET 이 아닌 요청은 건드리지 않는다', () => {
    expect(sw).toMatch(/request\.method !== 'GET'\) return/);
  });
});
