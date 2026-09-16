import { spawn } from 'node:child_process';
import path from 'node:path';

/**
 * 앱이 뜰 때 소식 동기화를 한 번 띄웁니다 (instrumentation.ts register).
 *
 * ─── 왜 자식 프로세스인가 ─────────────────────────────────
 * scripts/sync-news.mjs 를 **import 하지 않습니다.** 그 파일은 혼자 도는 프로그램
 * 전제로 쓰여 있습니다 — 모듈 최상위에서 pg.Client 를 열고, 끝에서 db.end() 를
 * 부르고, 설정이 없으면 process.exit 합니다. 서버 안으로 끌어들이면 그 습관이
 * 그대로 서버의 습관이 됩니다. 밖에서 부르면 그 세 가지가 전부 남의 집 일입니다.
 *
 * ─── 왜 기다리지 않는가 ───────────────────────────────────
 * register() 는 **서버가 요청을 받기 전에 끝나야 합니다**(Next 문서). 여기서
 * 남의 사이트 두 곳을 기다리면 그 응답 시간이 곧 우리 기동 시간이 되고,
 * scripts/start-cluster.mjs 의 health 프로브가 그동안 503 을 뿌립니다.
 * 그래서 띄우기만 하고 `unref()` 로 놓아 줍니다.
 *
 * ─── 몇 번 도는가 ─────────────────────────────────────────
 * register() 는 **프로세스마다** 한 번입니다. 운영은 인스턴스가 둘이고
 * (start-cluster.mjs INSTANCES), 죽으면 다시 뜹니다. 그래서 실제로 받아 오는
 * 일은 스크립트 쪽 `--on-start` 가 DB 창(rate_counters 'news:sync')으로 막습니다 —
 * 여기서 세는 것은 의미가 없습니다. 아래 globalThis 표식은 같은 프로세스 안에서
 * dev 의 이중 호출만 막는 싸구려 빗장입니다.
 *
 * ─── 끄는 법 ──────────────────────────────────────────────
 * `.env.local` 에 NEWS_SYNC_ON_START=0. 간격은 NEWS_SYNC_MIN_HOURS (기본 6시간).
 */

const FLAG = Symbol.for('arcade-finder.news-sync-boot');

type Marked = typeof globalThis & { [FLAG]?: boolean };

export function startNewsSync(): void {
  if (process.env.NEWS_SYNC_ON_START === '0') return;

  const g = globalThis as Marked;
  if (g[FLAG]) return;
  g[FLAG] = true;

  const script = path.join(process.cwd(), 'scripts', 'sync-news.mjs');

  try {
    const child = spawn(process.execPath, [script, '--on-start'], {
      cwd: process.cwd(),
      // ⚠ NODE_USE_SYSTEM_CA 는 노드가 **시작할 때** 읽습니다. piugame.com 이 중간
      //   인증서를 보내지 않아, 이것이 없으면 UNABLE_TO_VERIFY_LEAF_SIGNATURE 로
      //   실패합니다 (scripts/sync-news.cmd 에 같은 줄이 있습니다). 검증을 끄는 것이
      //   아니라 믿을 곳을 OS 저장소에 맡기는 것입니다.
      env: { ...process.env, NODE_USE_SYSTEM_CA: '1' },
      // 개발 중에는 dev 콘솔에, 운영에서는 systemd 저널에 그대로 남습니다.
      stdio: 'inherit',
    });
    child.on('error', (err) => {
      console.warn('[news-sync] 띄우지 못했습니다 —', err.message);
    });
    // 부모가 이 자식을 기다리지 않게 합니다.
    child.unref();
  } catch (err) {
    // 어떤 이유로든 여기서 서버 기동이 막히면 안 됩니다.
    console.warn('[news-sync] 건너뜁니다 —', err instanceof Error ? err.message : String(err));
  }
}
