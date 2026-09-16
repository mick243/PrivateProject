/**
 * 리듬게임 공식 소식을 메인 '최신소식' 으로 가져옵니다.
 *
 *   node scripts/sync-news.mjs --dry-run           무엇이 바뀔지만 출력
 *   node scripts/sync-news.mjs                     실제로 반영
 *   node scripts/sync-news.mjs --source piugame    한 곳만
 *   node scripts/sync-news.mjs --limit 3           출처마다 가져올 개수 (기본 2)
 *
 * 매일 한 번 돌리는 자리입니다 (scripts/sync-news.cmd 에 등록 방법).
 *
 * ─── ⚠ 남의 사이트를 긁는 일입니다 ────────────────────────
 * piugame.com 의 robots.txt 는 `User-agent: * / Disallow: /` 입니다 — 자동 수집을
 * 원하지 않는다는 뜻이고, 이 스크립트는 그 뜻을 거스릅니다. 운영자가 그것을 알고
 * 돌리기로 한 자리입니다. p.eagate.573.jp 는 robots.txt 가 아예 없습니다(404).
 *
 * 어느 쪽이든 최소한은 지킵니다:
 *   · 하루 **한 번**, 출처마다 목록 페이지 **한 장**만. 상세는 열지 않습니다.
 *   · User-Agent 에 무엇인지 밝힙니다. 브라우저인 척하지 않습니다.
 *   · 실패하면 그냥 끝냅니다. 다시 두드리지 않습니다.
 *   · 본문을 **가져오지 않습니다** — 제목·날짜·원문 링크만 옮깁니다. 남의 글을
 *     통째로 복사해 우리 게시판에 세우지 않기 위해서입니다.
 * 상대가 막으면 막힌 채로 두세요. 우회를 붙이는 순간 성질이 달라집니다.
 *
 * ─── 무엇을 지우는가 ──────────────────────────────────────
 * imported_news(migrate-063)에 적힌 글**만**, 그것도 **그 출처의 것만** 지웁니다.
 * 제목으로 짐작해 지우면 언젠가 사람이 쓴 글을 지웁니다.
 *
 * ─── 제목을 번역하지 않습니다 ─────────────────────────────
 * eagate 는 일본어입니다. 사람이 안 보는 자리에서 기계 번역을 돌리면, 틀린 제목이
 * 메인 첫 화면에 걸린 채 아무도 모릅니다. 원문 그대로 싣고 번역은 사람 몫으로
 * 둡니다.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

// .env.local 을 최소한으로 파싱 (scripts/init-db.mjs 와 같은 방식)
const envFile = path.join(root, '.env.local');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
/**
 * 앱이 뜰 때 딸려 도는 모드 (instrumentation.ts 가 자식 프로세스로 부릅니다).
 *
 * 사람이 손으로 부르는 것과 두 가지가 다릅니다.
 *   · **N 시간에 한 번만** 실제로 돕니다. dev 서버는 하루에 수십 번 재시작하는데
 *     그때마다 남의 사이트를 두드리면, 이 파일 머리말이 스스로 약속한 '하루 한 번'
 *     이 거짓말이 됩니다.
 *   · **절대 실패로 끝나지 않습니다.** 남의 서버 사정으로 우리 앱 기동이 흔들리면
 *     안 됩니다.
 */
const onStart = argv.includes('--on-start');
const pick = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
};
const hoursEnv = Number(process.env.NEWS_SYNC_MIN_HOURS);
/** 창은 24시간 이하로 둡니다 — lib/rate-limit.ts 의 청소가 그보다 오래된 줄을 지웁니다 */
const MIN_HOURS = Number.isFinite(hoursEnv) && hoursEnv > 0 ? Math.min(hoursEnv, 24) : 6;
const startDelayMs = Number(process.env.NEWS_SYNC_START_DELAY_MS);
/** 기동 직후엔 마이그레이션(첫 DB 접근)이 아직 안 돌았을 수 있어 조금 기다립니다 */
const START_DELAY_MS = Number.isFinite(startDelayMs) && startDelayMs >= 0 ? startDelayMs : 5_000;
const limitArg = Number(pick('--limit'));
const LIMIT = Number.isInteger(limitArg) && limitArg > 0 ? Math.min(limitArg, 6) : 2;
const only = pick('--source');

// 헤더 값은 latin-1 만 담깁니다 — 한글을 넣으면 fetch 가 던집니다.
const UA = 'arcade-finder-news/1.0 (arcade-finder news sync; once a day; list page only)';

const bail = (msg) => {
  console.error(`✖ ${msg}`);
  process.exit(1);
};
if (!process.env.DATABASE_URL) {
  // 기동에 딸려 도는 모드에서는 앱을 방해하지 않고 조용히 물러납니다.
  if (onStart) process.exit(0);
  bail('DATABASE_URL 이 없습니다 (.env.local).');
}

// ─── 공통: 목록 한 장 받기 ───────────────────────────────────

/**
 * 리다이렉트를 손으로 따라갑니다 — **쿠키를 들고 가야 하기 때문입니다.**
 *
 * piugame 은 첫 요청을 세션 발급 주소(/ssoc?sid=…)로 보냈다가 되돌려 보냅니다.
 * `fetch` 의 자동 리다이렉트는 쿠키를 기억하지 않아서, 받은 세션을 못 돌려주고
 * 같은 자리를 무한히 오갑니다 (`redirect count exceeded`). 브라우저가 늘 하는
 * 일을 그대로 합니다 — 봇 차단을 뚫는 것이 아니라, 평범한 HTTP 클라이언트가
 * 해야 할 쿠키 처리입니다.
 */
async function fetchPage(startUrl) {
  const jar = new Map();
  let url = startUrl;

  for (let hop = 0; hop < 5; hop++) {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        // piugame 은 이게 없으면 영어판을 줍니다 — 제목이 잘리고 글 번호도 다릅니다.
        'Accept-Language': 'ko-KR,ko;q=0.9,ja;q=0.8',
        Accept: 'text/html',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      redirect: 'manual',
      // 남의 서버가 매달리면 우리도 같이 매달립니다. lib/telemetry.ts 와 같은 방식.
      signal: AbortSignal.timeout(10_000),
    });

    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const i = pair.indexOf('=');
      if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }

    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get('location');
      if (!next) throw new Error(`리다이렉트에 주소가 없습니다 (HTTP ${res.status})`);
      url = new URL(next, url).toString();
      continue;
    }
    if (!res.ok) throw new Error(`목록을 받지 못했습니다 (HTTP ${res.status})`);
    return res.text();
  }
  throw new Error('리다이렉트가 끝나지 않습니다 — 사이트 쪽이 바뀌었을 수 있습니다');
}

const stripTags = (s) => s.replace(/<[^>]+>/g, '');
const unescape = (s) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');

/*
  HTML 파서를 붙이지 않는 이유: 의존성 하나를 늘릴 만큼 복잡한 문서가 아니고,
  이 페이지들의 구조가 바뀌면 파서가 있어도 어차피 여기를 고쳐야 합니다. 대신
  **하나도 못 뽑으면 실패로 끝냅니다** — 조용히 0건이면 "소식이 없다" 와
  구분되지 않아, 멀쩡한 글을 지우고 빈칸을 남길 수 있습니다.
*/

// ─── 출처 1: 펌프 잇 업 (piugame.com) ────────────────────────

/** 원문 말머리 → 우리 말머리. '공지' 는 쓰지 않습니다(아래 CATEGORY_NOTE 참고) */
const PIU_CATEGORY = { 이벤트: 'contest', 업데이트: 'info', 공지: 'info' };

function parsePiu(html, source) {
  const body = html.slice(html.indexOf('<tbody'), html.indexOf('</tbody>'));
  const rows = [];
  const re = /<tr>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const tr = m[1];
    const type = /class="w_type"[\s\S]*?<i[^>]*>([^<]+)<\/i>/.exec(tr)?.[1]?.trim();
    const link = /class="w_tit"[\s\S]*?<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(tr);
    const date = /class="w_date">\s*([0-9.]+)\s*<\/td>/.exec(tr)?.[1]?.trim();
    if (!type || !link || !date) continue;
    const id = /wr_id=(\d+)/.exec(link[1])?.[1];
    const title = unescape(stripTags(link[2])).replace(/\s+/g, ' ').trim();
    if (!id || title === '') continue;
    rows.push({
      id,
      title,
      category: PIU_CATEGORY[type] ?? 'info',
      url: new URL(link[1], source.url).toString(),
      date: date.replace(/\./g, '-').replace(/-$/, ''),
    });
  }
  return rows;
}

// ─── 출처 2: 사운드 볼텍스 (p.eagate.573.jp) ─────────────────

/** 글자다운 글자. 얼굴문자(６＞▼μ▼＜９)를 걸러 내는 잣대입니다 */
const WORDY = /[0-9A-Za-z぀-ヿ一-鿿가-힯]/g;

/** 제목에 이 말이 들어 있으면 '대회'. 없으면 '정보' — eagate 는 말머리가 없습니다 */
const SDVX_CONTEST = /(コンテスト|大会|選手権|トーナメント)/;

/**
 * eagate 뉴스는 **글마다 주소가 없습니다.** 한 페이지에 쭉 나열되는 방식이라
 * 링크는 목록 페이지로 가고, "같은 글인가" 는 날짜로 판단합니다.
 *
 * 항목 경계는 `<li>` 입니다 — 화면에서 날짜를 가르는 그 초록 가로선
 * (border-top: 1px solid rgb(114,164,0))이 바로 이 `li` 의 윗선입니다.
 * 맨 위 항목에만 선이 없습니다(위에 그을 것이 없으므로).
 *
 * 갈피(분기별 탭)가 넷인데 지금 열려 있는 것 하나만 `hide` 가 없습니다.
 */
function parseSdvx(html, source) {
  const tabs = [...html.matchAll(/<div class="tab([^"]*)"/g)].map((m) => ({
    at: m.index,
    hidden: m[1].includes('hide'),
  }));
  if (tabs.length === 0) return [];
  const open = tabs.find((t) => !t.hidden) ?? tabs[tabs.length - 1];
  const seg = html.slice(open.at);

  const rows = [];
  for (const m of seg.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)) {
    const lines = unescape(stripTags(m[1].replace(/<br\s*\/?>/g, '\n')))
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const date = lines[0];
    if (!/^\d{4}\.\d{1,2}\.\d{1,2}$/.test(date ?? '')) continue;

    /*
      첫 줄은 대개 마스코트 말투입니다("６＞▼μ▼＜９ YOU ARE No.1!!!").
      제목으로 쓸 수 없으므로, 뒤이은 몇 줄 중 **글자가 가장 많은 줄**을 고릅니다.
      얼굴문자는 기호라 이 잣대에서 점수를 거의 못 받습니다.
    */
    const cand = lines.slice(1, 5);
    if (cand.length === 0) continue;
    const title = cand
      .reduce((best, l) => ((l.match(WORDY) ?? []).length > (best.match(WORDY) ?? []).length ? l : best))
      .slice(0, 100);
    if (title === '') continue;

    const [y, mo, d] = date.split('.');
    rows.push({
      id: date, // 글마다 주소도 번호도 없습니다 — 날짜가 유일한 열쇠입니다
      title,
      category: SDVX_CONTEST.test(title) ? 'contest' : 'info',
      url: source.url,
      date: `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`,
    });
  }
  return rows;
}

// ─── 출처 목록 ───────────────────────────────────────────────

/**
 * '공지' 말머리는 쓰지 않습니다 — 그건 게시판 맨 위에 고정되는 **우리 서비스의**
 * 공지라(lib/board.ts NOTICE_PIN_LIMIT), 남의 게임 점검 안내가 거기 박히면
 * 뜻이 어긋납니다.
 */
const SOURCES = [
  {
    key: 'piugame',
    label: '펌프 잇 업',
    url: 'https://piugame.com/phoenix2_notice',
    machine: 'Pump It Up',
    note: '펌프 잇 업 PHOENIX 2 공식 공지입니다.',
    parse: parsePiu,
  },
  {
    key: 'eagate-sdvx',
    label: '사운드 볼텍스',
    url: 'https://p.eagate.573.jp/game/sdvx/vii/news/index.html',
    machine: 'SOUND VOLTEX',
    note: 'SOUND VOLTEX 공식 소식입니다. 원문은 일본어입니다.',
    parse: parseSdvx,
  },
];

// ─── DB ──────────────────────────────────────────────────────

const { default: pg } = await import('pg');
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
try {
  await db.connect();
} catch (err) {
  // ⚠ 이 자리는 모듈 최상위라 아래 try/catch 가 잡지 못합니다. 감싸지 않으면
  //   DB 가 잠깐 없을 때 처리되지 않은 예외로 스택이 통째로 찍히고 1 로 죽습니다.
  //   기동에 딸려 도는 모드에서는 그게 dev 콘솔과 운영 저널을 더럽힙니다.
  const why = err instanceof Error ? err.message : String(err);
  if (onStart) {
    console.log(`· 소식 동기화: DB 에 붙지 못해 건너뜁니다 (${why})`);
    process.exit(0);
  }
  console.error(`✖ DB 에 붙지 못했습니다 — ${why}`);
  process.exit(1);
}

const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];

function docOf(note, title, url) {
  return {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: `${note} 원문: ${title}` }] },
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: `원문 보기 — ${new URL(url).host}`,
            marks: [{ type: 'link', attrs: { href: url } }],
          },
        ],
      },
    ],
  };
}

async function syncOne(source, ids) {
  const rows = source.parse(await fetchPage(source.url), source).slice(0, LIMIT);
  if (rows.length === 0) {
    throw new Error(`${source.label}: 목록에서 글을 하나도 뽑지 못했습니다 — 페이지 구조가 바뀌었을 수 있습니다`);
  }

  const { rows: have } = await db.query(
    `SELECT source_id, title, post_id FROM imported_news WHERE source = $1`,
    [source.key],
  );

  // 바뀐 것이 없으면 아무것도 건드리지 않습니다 — 글 id 가 매일 바뀌면
  // 링크를 저장해 둔 사람의 주소가 매일 깨집니다.
  const key = (list) => list.map((r) => `${r.id ?? r.source_id}:${r.title}`).sort().join('|');
  if (key(rows) === key(have)) {
    console.log(`· ${source.label}: 변화 없음`);
    return;
  }

  console.log(`· ${source.label}: 새 목록`);
  for (const r of rows) console.log(`    [${r.category}] ${r.title} (${r.date})`);
  if (have.length) console.log(`    치울 글: ${have.map((h) => `#${h.post_id}`).join(', ')}`);
  if (dryRun) return;

  await db.query('BEGIN');
  try {
    if (have.length > 0) {
      // imported_news 에 적힌 글만, 그것도 이 출처의 것만 지웁니다.
      await db.query(`DELETE FROM posts WHERE id = ANY($1::int[])`, [have.map((h) => h.post_id)]);
    }
    for (const r of rows) {
      const body = `${source.note}\n\n원문: ${r.title}\n${r.url}`;
      // 작성일은 원문 날짜로 둡니다 — 최신소식이 created_at 순이라, 오늘로 넣으면
      // 며칠 전 공지가 오늘 소식으로 보입니다.
      const post = await one(
        `INSERT INTO posts (machine_id, category, player_id, title, body, body_doc, created_at, updated_at)
              VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz, $7::timestamptz)
           RETURNING id`,
        [
          ids.machine[source.machine],
          r.category,
          ids.admin,
          r.title,
          body,
          JSON.stringify(docOf(source.note, r.title, r.url)),
          `${r.date} 10:00+09`,
        ],
      );
      await db.query(
        `INSERT INTO imported_news (source, source_id, post_id, title, url) VALUES ($1, $2, $3, $4, $5)`,
        [source.key, r.id, post.id, r.title, r.url],
      );
      console.log(`    ✔ #${post.id}`);
    }
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

/**
 * "이번 창에서 아직 안 돌았다" 를 **원자적으로** 집습니다 (rate_counters, migrate-054).
 *
 * 인스턴스가 둘이면(scripts/start-cluster.mjs INSTANCES=2) 둘이 동시에 뜨고 둘 다
 * 이 자리에 옵니다. 읽고-판단하고-쓰기로 나누면 둘 다 통과해 같은 글을 두 번
 * 지우고 두 번 넣습니다. UPSERT 한 문장이면 한쪽만 줄을 받습니다.
 *
 * 표식을 파일이 아니라 DB 에 두는 이유: 워크트리가 여럿이라 파일 표식은 폴더를
 * 옮기는 순간 새로 태어납니다. 상대 사이트 입장에서 옳은 경계는 '이 DB 를 쓰는
 * 우리 서비스 전체' 입니다.
 *
 * ⚠ 일을 **하기 전에** 창을 태웁니다. 받아 오다 실패해도 다음 창까지 재시도하지
 *   않는다는 뜻입니다 — 되돌리는 함수를 만들지 않는 것은 lib/rate-limit.ts 가
 *   일부러 세운 규칙(넘긴 요청도 센다)을 흔들지 않기 위해서입니다. 정본은 어차피
 *   하루 한 번 도는 작업 스케줄러(scripts/sync-news.cmd)입니다.
 */
async function claimWindow() {
  const { rowCount } = await db.query(
    `INSERT INTO rate_counters (key, window_start, count)
          VALUES ('news:sync', now(), 1)
     ON CONFLICT (key) DO UPDATE
            SET window_start = now(), count = rate_counters.count + 1
          WHERE rate_counters.window_start < now() - make_interval(hours => $1::int)
       RETURNING key`,
    [MIN_HOURS],
  );
  return rowCount > 0;
}

async function main() {
  if (onStart) {
    // 기동 직후에는 마이그레이션이 아직 안 돌았을 수 있습니다 — lib/db.ts 의 getDb()
    // 는 지연 호출이라 첫 요청(클러스터의 health 프로브)에서야 스키마가 적용됩니다.
    if (START_DELAY_MS > 0) await new Promise((r) => setTimeout(r, START_DELAY_MS));
    if (!(await claimWindow())) {
      console.log(`· 소식 동기화: ${MIN_HOURS}시간 안에 이미 돌았습니다 — 건너뜁니다`);
      return;
    }
  }

  const targets = only ? SOURCES.filter((s) => s.key === only) : SOURCES;
  if (targets.length === 0) bail(`--source 값이 이상합니다. 쓸 수 있는 값: ${SOURCES.map((s) => s.key).join(', ')}`);

  const admin = await one(`SELECT id FROM players WHERE is_admin ORDER BY id LIMIT 1`);
  if (!admin) throw new Error('관리자 계정이 없습니다 — 글쓴이로 쓸 사람이 없습니다');
  const { rows: machines } = await db.query(`SELECT id, name FROM machines WHERE name = ANY($1::text[])`, [
    targets.map((s) => s.machine),
  ]);
  const byName = Object.fromEntries(machines.map((m) => [m.name, m.id]));
  for (const s of targets) {
    if (!byName[s.machine]) throw new Error(`기종 '${s.machine}' 이 없습니다 (${s.label})`);
  }

  // 한 곳이 막혀도 다른 곳은 갱신되어야 합니다 — 남의 서버 사정에 우리 화면 전체가
  // 묶이면 안 됩니다. 실패한 출처는 그대로 두고(옛 글 유지) 종료 코드만 남깁니다.
  let failed = 0;
  for (const source of targets) {
    try {
      await syncOne(source, { admin: admin.id, machine: byName });
    } catch (err) {
      failed += 1;
      const why = err instanceof Error ? err.message : String(err);
      const cause = err instanceof Error && err.cause ? (err.cause.code ?? err.cause.message) : null;
      console.error(`✖ ${source.label}: ${why}${cause ? ` (${cause})` : ''}`);
    }
  }
  if (dryRun) console.log('(--dry-run — 반영하지 않았습니다)');
  // 기동에 딸려 도는 모드는 절대 실패로 끝내지 않습니다 — npm 의 pre* 훅이든
  // 부모 프로세스든, 우리 실패가 앱 기동을 막을 자리를 만들지 않습니다.
  if (failed > 0 && !onStart) process.exitCode = 1;
}

try {
  await main();
} catch (err) {
  // 사람이 안 보는 자리에서 도는 스크립트입니다. 'fetch failed' 한 줄만 남으면
  // 로그를 봐도 왜인지 알 수 없어서, 원인(cause)까지 같이 적습니다.
  const why = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error && err.cause ? (err.cause.code ?? err.cause.message ?? String(err.cause)) : null;
  console.error(`✖ ${why}${cause ? ` (${cause})` : ''}`);
  if (!onStart) process.exitCode = 1;
} finally {
  await db.end();
}
