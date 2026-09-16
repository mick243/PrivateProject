/**
 * PWA 아이콘 PNG 생성 — 의존성 없이 (zlib 만).
 *
 *   npm run pwa:icons
 *
 * app/icon.svg 와 같은 그림(어두운 바탕 · 보라 핀 · 흰 사각 = 기체)을 래스터로 그립니다.
 * 이미지 라이브러리(sharp 등)를 붙이지 않은 이유: 아이콘 6장 때문에 네이티브 의존성을
 * 들이면 CI 와 Windows 설치가 무거워집니다. 그림이 단순해서 원·삼각형·사각형만 있으면
 * 됩니다. 3×3 슈퍼샘플링으로 가장자리를 부드럽게 합니다.
 *
 * 만드는 것
 *   public/icons/icon-{192,512}.png            purpose any    — 둥근 모서리, 모서리 투명
 *   public/icons/icon-maskable-{192,512}.png   purpose maskable — 꽉 찬 정사각형, 핀은 안전 영역(80%) 안
 *   app/apple-icon.png (180)                    iOS 홈 화면 (Next 파일 규약이 <link> 를 자동으로 붙임)
 *
 * 그림을 바꾸면 app/icon.svg 도 같이 바꾸세요 — 둘이 다르면 탭 아이콘과 홈 화면 아이콘이 다릅니다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

// 경로에 한글이 있어 URL.pathname 을 그대로 쓰면 퍼센트 인코딩된 엉뚱한 폴더에 씁니다 — fileURLToPath 로.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const BG = [0x16, 0x1a, 0x22, 255];
const PIN = [0x6d, 0x5e, 0xfc, 255];
const DARK = [0x16, 0x1a, 0x22, 255];
const WHITE = [0xe6, 0xe8, 0xef, 255];
const CLEAR = [0, 0, 0, 0];

/**
 * 한 점(0~1 정규 좌표)이 어느 색인지. 뒤에 그린 것이 앞에 옵니다.
 * @param {number} x @param {number} y
 * @param {{ rounded: boolean, safe: number }} opt  safe: 핀을 그릴 영역 비율(1 = 전체)
 */
function colorAt(x, y, opt) {
  // 바탕 — 둥근 모서리(any) 또는 꽉 찬 사각(maskable)
  if (opt.rounded) {
    const r = 0.22;
    const cx = Math.min(Math.max(x, r), 1 - r);
    const cy = Math.min(Math.max(y, r), 1 - r);
    if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) return CLEAR;
  }
  let color = BG;

  // 안전 영역 안으로 축소해 핀을 그립니다
  const s = opt.safe;
  const px = (x - 0.5) / s + 0.5;
  const py = (y - 0.5) / s + 0.5;

  // 핀 = 원(중심 0.5,0.40 · r 0.26) + 아래로 모이는 삼각형(끝 0.5,0.88)
  const cx = 0.5;
  const cy = 0.4;
  const R = 0.26;
  const tipY = 0.88;
  const inCircle = (px - cx) ** 2 + (py - cy) ** 2 <= R * R;
  let inTri = false;
  if (py >= cy && py <= tipY) {
    // 원의 접점 근사: 원 중심 높이에서 폭 R, 끝점에서 폭 0 으로 선형
    const t = (py - cy) / (tipY - cy);
    const half = R * (1 - t) * 0.92;
    inTri = Math.abs(px - cx) <= half;
  }
  if (inCircle || inTri) color = PIN;

  // 핀 안의 어두운 원 + 흰 사각(기체 화면)
  const innerR = 0.125;
  if ((px - cx) ** 2 + (py - cy) ** 2 <= innerR * innerR) color = DARK;
  const sq = 0.065;
  if (Math.abs(px - cx) <= sq && Math.abs(py - cy) <= sq) color = WHITE;

  return color;
}

/** @param {number} size @param {{ rounded: boolean, safe: number }} opt */
function render(size, opt) {
  const SS = 3;
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const c = colorAt((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size, opt);
          // 알파 가중 평균 (투명 모서리가 검게 번지지 않도록)
          r += c[0] * c[3];
          g += c[1] * c[3];
          b += c[2] * c[3];
          a += c[3];
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      if (a === 0) {
        out[i] = out[i + 1] = out[i + 2] = out[i + 3] = 0;
      } else {
        out[i] = Math.round(r / a);
        out[i + 1] = Math.round(g / a);
        out[i + 2] = Math.round(b / a);
        out[i + 3] = Math.round(a / n);
      }
    }
  }
  return out;
}

/** 최소 PNG 인코더 — 8비트 RGBA, 필터 0 */
function encodePng(size, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeBuf = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([typeBuf, data])) >>> 0);
    return Buffer.concat([len, typeBuf, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const targets = [
  ['public/icons/icon-192.png', 192, { rounded: true, safe: 1 }],
  ['public/icons/icon-512.png', 512, { rounded: true, safe: 1 }],
  ['public/icons/icon-maskable-192.png', 192, { rounded: false, safe: 0.8 }],
  ['public/icons/icon-maskable-512.png', 512, { rounded: false, safe: 0.8 }],
  // iOS 는 스스로 둥글게 자르므로 꽉 찬 사각 + 약간의 여백
  ['app/apple-icon.png', 180, { rounded: false, safe: 0.9 }],
];

for (const [rel, size, opt] of targets) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodePng(size, render(size, opt)));
  console.log(`✔ ${rel} (${size}×${size}, ${fs.statSync(file).size} bytes)`);
}
