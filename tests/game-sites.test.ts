import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GAME_SITES, hostOf } from '@/lib/game-sites';

/*
 * 홈 배너의 게임 공식 홈페이지 목록 (lib/game-sites.ts) 과, 그 결정으로 기본값이 꺼짐이
 * 된 기동 시 소식 동기화 (lib/news-sync-boot.ts).
 */

/** machines 를 넣는 SQL 전부 — 이름은 여기서만 정해집니다 */
function machineSql(): string {
  const dir = path.resolve(__dirname, '../prisma/migrations');
  return fs
    .readdirSync(dir)
    .map((d) => path.join(dir, d, 'migration.sql'))
    .filter((f) => fs.existsSync(f))
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n');
}

describe('GAME_SITES', () => {
  it('이름은 machines.name 과 같은 표기다 — 다른 화면과 어긋나지 않게', () => {
    const sql = machineSql();
    for (const site of GAME_SITES) {
      expect(sql, site.name).toContain(`'${site.name.replace(/'/g, "''")}'`);
    }
  });

  it('주소는 https 이고 겹치지 않는다', () => {
    const urls = GAME_SITES.map((s) => s.url);
    expect(new Set(urls).size).toBe(urls.length);
    for (const url of urls) expect(new URL(url).protocol).toBe('https:');
  });

  it('공식 사이트가 없는 EZ2 계열은 넣지 않는다 (머리말 — 끊긴 도메인)', () => {
    expect(GAME_SITES.some((s) => /ez2/i.test(s.name + s.url))).toBe(false);
  });

  it('hostOf 는 호스트만 돌려준다', () => {
    expect(hostOf('https://p.eagate.573.jp/game/sdvx/')).toBe('p.eagate.573.jp');
  });
});

describe('startNewsSync — 기본은 꺼짐', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock('node:child_process');
    vi.resetModules();
  });

  async function boot(value: string | undefined) {
    vi.resetModules();
    const spawn = vi.fn(() => ({ on: vi.fn(), unref: vi.fn() }));
    vi.doMock('node:child_process', () => ({ spawn }));
    if (value === undefined) vi.stubEnv('NEWS_SYNC_ON_START', '');
    else vi.stubEnv('NEWS_SYNC_ON_START', value);
    // 같은 프로세스 안의 이중 호출을 막는 표식이 남아 있으면 두 번째 시험이 속습니다
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('arcade-finder.news-sync-boot')];
    const { startNewsSync } = await import('@/lib/news-sync-boot');
    startNewsSync();
    return spawn;
  }

  it('설정이 없으면 남의 사이트를 긁는 자식 프로세스를 띄우지 않는다', async () => {
    expect(await boot(undefined)).not.toHaveBeenCalled();
  });

  it('예전의 끄기 값(0)도 그대로 꺼짐이다', async () => {
    expect(await boot('0')).not.toHaveBeenCalled();
  });

  it('NEWS_SYNC_ON_START=1 일 때만 띄운다', async () => {
    expect(await boot('1')).toHaveBeenCalledTimes(1);
  });
});
