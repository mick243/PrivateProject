/**
 * 네이버 지역 검색으로 실제 오락실을 가져와 arcades 를 채웁니다.
 *
 *   npm run arcades:import                     미리보기 (DB·상태파일 안 건드림)
 *   npm run arcades:import -- --write          반영 (이어서 하기 포함)
 *   npm run arcades:import -- --status         지금까지 어디까지 했는지만 보기
 *   npm run arcades:import -- --reset          진행 상태를 버리고 처음부터
 *   npm run arcades:import -- --write --limit 500      오늘 호출 상한 조정
 *   npm run arcades:import -- --query "홍대 오락실"     전국 목록 대신 직접 지정
 *
 * ─────────────────────────────────────────────────────────────────────
 * [하루 한도와 이어서 하기]
 *
 * 전국 질의는 (시·군·구 × 표현) 이라 수백~수천 건이고, 네이버 지역 검색은
 * **하루 25,000회** 무료 한도가 있습니다. 그래서 하루 상한(기본 20,000)을 두고,
 * 넘으면 그 자리에서 멈춘 뒤 다음 날 이어서 합니다.
 *
 * 진행 상태는 .arcade-import-state.json 에 남습니다:
 *   day          호출 수를 센 날짜 (바뀌면 카운터를 0 으로 되돌립니다)
 *   callsToday   그날 쓴 호출 수
 *   doneQueries  끝낸 질의 — 다음 실행은 이걸 건너뜁니다
 *   places       지금까지 모은 장소 (중복 제거 전)
 *
 * **호출 1건마다 저장합니다.** 중간에 죽으면 그때까지 쓴 호출 수를 잊게 되고,
 * 다음 실행이 한도를 넘겨 버리기 때문입니다.
 *
 * DB 반영은 매 실행마다 합니다 (이름+주소 기준 upsert 라 여러 번 해도 안전).
 * 단 `--drop-seed` 의 (가상) 데이터 삭제는 **질의 목록을 다 돈 실행에서만**
 * 수행합니다 — 절반만 모은 상태에서 예시 데이터를 지우면, 다음 날까지 목록이
 * 텅 빈 채로 남습니다.
 * ─────────────────────────────────────────────────────────────────────
 *
 * .ts 로 두는 이유: Node 24 는 타입만 지운 채 .ts 를 그대로 실행하므로
 * lib/naver-local.ts 와 lib/prisma.ts 를 **그대로 가져다 씁니다**. 파싱·좌표 변환을
 * .mjs 로 옮겨 적으면 테스트가 검증하는 코드와 실제로 도는 코드가 갈라집니다.
 *
 * ⚠ 가져오는 것과 못 가져오는 것
 *     이름 · 주소 · 좌표 → 네이버 지역 검색이 줍니다.
 *     영업시간           → **응답에 그 필드가 없습니다.** NULL(정보 없음)로 넣고,
 *                          확인용 네이버 지도 검색 링크를 source_ref 에 남깁니다.
 *     보유 기종          → 네이버가 알 수 없는 정보입니다. 비어 있고,
 *                          기존처럼 제보로 채워집니다.
 *   자세한 사정은 lib/naver-local.ts 의 파일 주석에 적어 두었습니다.
 */

import { BULK_TX_OPTIONS, getPrismaClient } from '../lib/prisma.ts';
import {
  crawlArcades,
  dedupePlaces,
  isArcadePlace,
  isExcludedByName,
  type ArcadePlace,
} from '../lib/naver-local.ts';
import { buildArcadeQueries, countRegions } from '../lib/kr-regions.ts';
import { loadScriptEnv } from '../lib/script-env.ts';
import fs from 'node:fs';
import path from 'node:path';

// ─── .env.local (lib/script-env.ts — scripts/ 의 .ts 도구 공용) ────────
const root = process.cwd();
loadScriptEnv(root);

// ─── 인자 ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (flag: string) => argv.includes(flag);
const valueOf = (flag: string): string | null => {
  const i = argv.indexOf(flag);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
};

const write = has('--write');
const dropSeed = has('--drop-seed');
const statusOnly = has('--status');
const reset = has('--reset');
const cliQueries = argv.flatMap((a, i) => (a === '--query' ? [argv[i + 1] ?? ''] : [])).filter(Boolean);

/** 하루 호출 상한. 네이버 무료 한도 25,000 보다 낮게 잡아 여유를 둡니다 */
const DEFAULT_DAILY_LIMIT = 20_000;
const dailyLimit = Number(valueOf('--limit') ?? DEFAULT_DAILY_LIMIT);
if (!Number.isFinite(dailyLimit) || dailyLimit < 0) {
  console.error('\n✖ --limit 은 0 이상의 숫자여야 합니다\n');
  process.exit(1);
}

function fail(msg: string): never {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

// ─── 진행 상태 ───────────────────────────────────────────────────────
const STATE_FILE = path.join(root, '.arcade-import-state.json');

interface State {
  /** 호출 수를 센 날짜 (YYYY-MM-DD, 로컬 기준) */
  day: string;
  callsToday: number;
  doneQueries: string[];
  /** 중복 제거 전 누적 수집분 */
  places: ArcadePlace[];
  lastRunAt: string | null;
  /** 질의 목록을 끝까지 돈 적이 있는가 */
  completed: boolean;
}

function today(): string {
  // 로컬 날짜. 네이버 한도도 KST 자정에 초기화되므로 로컬 기준이 맞습니다.
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function emptyState(): State {
  return { day: today(), callsToday: 0, doneQueries: [], places: [], lastRunAt: null, completed: false };
}

function loadState(): State {
  if (!fs.existsSync(STATE_FILE)) return emptyState();
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as State;
    // 날짜가 바뀌면 호출 카운터만 초기화합니다. doneQueries·places 는 살려야
    // '이어서 하기' 가 됩니다.
    if (s.day !== today()) {
      s.day = today();
      s.callsToday = 0;
    }
    return s;
  } catch {
    // 깨진 상태 파일 때문에 작업이 막히면 안 되지만, 조용히 버리면 어제 진행분이
    // 사라진 것을 아무도 모릅니다. 알려주고 멈춥니다.
    fail(`${STATE_FILE} 을 읽을 수 없습니다. 확인 후 --reset 으로 새로 시작하세요.`);
  }
}

/**
 * 상태 저장. 임시 파일에 쓴 뒤 rename 합니다 — 저장 중에 죽어도 반쪽짜리 JSON 이
 * 남지 않습니다 (그러면 다음 실행이 위 catch 로 떨어져 진행분을 잃습니다).
 */
function saveState(s: State): void {
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_FILE);
}

if (reset) {
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
  console.log(`진행 상태를 지웠습니다 (${STATE_FILE})`);
}

const state = reset ? emptyState() : loadState();

/*
 * 저장된 장소를 **현재 필터로 다시 거릅니다.**
 *
 * 필터를 고쳤을 때 916회를 다시 쓰지 않고 반영하기 위한 것입니다. 처음 수집은
 * 카테고리 문자열 전체에 '오락' 이 있는지로 걸렀는데, 상위 분류가 "스포츠,오락"
 * 이라 종합운동장·골프연습장까지 통과했습니다. 지금 필터는 말단만 봅니다
 * (lib/naver-local.ts categoryLeaf).
 */
const beforeFilter = state.places.length;
state.places = state.places.filter(isArcadePlace);
if (state.places.length !== beforeFilter) {
  console.log(
    `저장된 ${beforeFilter}건을 현재 기준으로 다시 걸렀습니다 → ${state.places.length}건 ` +
      `(오락실이 아닌 ${beforeFilter - state.places.length}건 제외)`,
  );
  saveState(state);
}

// ─── 질의 목록 ───────────────────────────────────────────────────────
const queries = cliQueries.length ? cliQueries : buildArcadeQueries();
const doneSet = new Set(state.doneQueries);
const todo = queries.filter((q) => !doneSet.has(q));

function report(): void {
  console.log('');
  console.log('진행 상태');
  console.log(`  상태 파일     ${STATE_FILE}`);
  console.log(`  기준 날짜     ${state.day}`);
  console.log(`  오늘 호출     ${state.callsToday.toLocaleString()} / ${dailyLimit.toLocaleString()}`);
  if (!cliQueries.length) {
    console.log(`  전국 시·군·구 ${countRegions()}곳`);
  }
  console.log(`  질의          전체 ${queries.length} · 완료 ${queries.length - todo.length} · 남음 ${todo.length}`);
  console.log(`  모은 장소     ${state.places.length}건 (중복 제거 전) → ${dedupePlaces(state.places).length}곳`);
  console.log(`  전체 완료     ${state.completed ? '예' : '아니오'}`);
  console.log(`  마지막 실행   ${state.lastRunAt ?? '없음'}`);
  console.log('');
}

if (statusOnly) {
  report();
  process.exit(0);
}

report();

if (!todo.length) {
  console.log('남은 질의가 없습니다. 다시 모으려면 --reset 을 쓰세요.\n');
  if (!write) process.exit(0);
}

// 오늘 남은 예산
const budget = Math.max(0, dailyLimit - state.callsToday);
if (todo.length && budget === 0) {
  console.log(
    `오늘 상한(${dailyLimit.toLocaleString()}회)을 이미 다 썼습니다. ` +
      `날짜가 바뀌면 같은 명령으로 이어서 하면 됩니다.\n` +
      `남은 질의 ${todo.length}건 — 첫 번째: ${todo[0]}\n`,
  );
  process.exit(0);
}

// ─── 수집 ────────────────────────────────────────────────────────────
let sinceLastLog = 0;
const result = await crawlArcades(todo, {
  delayMs: 120, // 초당 요청 제한 회피
  maxCalls: budget,
  onCall: async ({ query, found, kept, callsUsed }) => {
    // 호출 1건마다 저장 — 중간에 죽어도 쓴 만큼은 정확히 기억합니다.
    state.callsToday += 1;
    state.doneQueries.push(query);
    state.places.push(...kept);
    state.lastRunAt = new Date().toISOString();
    saveState(state);

    sinceLastLog += 1;
    // 수백 건을 한 줄씩 찍으면 로그가 쓸려 내려가므로, 건진 게 있을 때와
    // 25건마다만 남깁니다.
    if (kept.length > 0 || sinceLastLog >= 25) {
      sinceLastLog = 0;
      console.log(
        `  [${state.callsToday}/${dailyLimit}] ${query.padEnd(24)} 검색 ${found} → 오락실 ${kept.length}` +
          (kept.length ? `  (${kept.map((k) => k.name).join(', ')})` : ''),
      );
    }
    void callsUsed;
  },
}).catch((e: Error) => {
  // 여기까지 온 호출분은 이미 저장돼 있습니다. 남은 것은 다음 실행이 이어서 합니다.
  saveState(state);
  fail(
    `${e.message}\n` +
      `  여기까지 진행분은 저장했습니다 (오늘 ${state.callsToday}회). ` +
      `원인을 고친 뒤 같은 명령으로 이어서 하세요.`,
  );
});

const hitLimit = result.remaining.length > 0;
if (!hitLimit) state.completed = true;
saveState(state);

const places = dedupePlaces(state.places);

console.log('');
console.log(`이번 실행 호출 ${result.callsUsed}회 · 오늘 누적 ${state.callsToday}회`);
console.log(`누적 수집 ${state.places.length}건 → 중복 제거 후 ${places.length}곳`);
if (hitLimit) {
  console.log('');
  console.log(`⏸ 오늘 상한(${dailyLimit.toLocaleString()}회)에 걸려 멈췄습니다.`);
  console.log(`   남은 질의 ${result.remaining.length}건 — 다음: ${result.remaining[0]}`);
  console.log(`   날짜가 바뀌면 같은 명령으로 이어서 합니다 (--status 로 확인).`);
}

if (!places.length) fail('가져온 오락실이 없습니다. 질의를 바꿔 보세요.');

if (!write) {
  console.log('\n미리보기입니다 (상태 파일에는 진행분이 저장됐습니다).');
  console.log('반영하려면 --write 를 붙이세요.\n');
  process.exit(0);
}

// ─── DB 반영 ─────────────────────────────────────────────────────────
// DATABASE_URL 이 없으면 여기서 멈춥니다 (lib/prisma.ts). 예전 경로(lib/db.ts)는 조용히
// .pglite 로 내려가 "끝났다" 고 말한 뒤 실 DB 에는 아무것도 남기지 않을 수 있었습니다.
const prisma = await getPrismaClient();

let inserted = 0;
let updated = 0;

await prisma.$transaction(async (tx) => {
  /*
   * 이미 들어가 있는 행 중 지금 기준에 안 맞는 것을 걷어냅니다.
   *
   * 필터를 고쳐도 DB 에 남은 옛 행은 그대로이기 때문입니다. 이름 기준으로만
   * 판단하므로(뽑기·가챠 전문점), 아직 안 돌린 지역이 있어도 안전합니다 —
   * 수집 범위와 무관하게 "이 이름은 오락실이 아니다" 는 항상 성립합니다.
   * 카테고리 기준까지 여기서 적용하면, 이어서 하기 중인 상태에서 아직 다시
   * 만나지 못한 지역의 행을 지워 버립니다.
   */
  const stale = await tx.arcades.findMany({
    where: { source: 'naver' },
    select: { id: true, name: true },
  });
  const toDrop = stale.filter((r) => isExcludedByName(r.name));
  if (toDrop.length) {
    await tx.arcades.deleteMany({ where: { id: { in: toDrop.map((r) => r.id) } } });
    console.log(
      `
뽑기·가챠 전문점 ${toDrop.length}곳 제거 (리듬게임 기체가 없는 업종)`,
    );
  }

  // 예시 데이터 삭제는 **다 모은 뒤에만**. 절반만 모은 상태에서 지우면 다음 날까지
  // 목록이 텅 빈 채로 남습니다.
  if (dropSeed && !hitLimit) {
    // 예시 데이터에 붙은 제보·리뷰는 그 오락실에 대한 **꾸며낸 이야기**입니다.
    // 실제 업소 행이 같은 id 를 물려받으면 남의 가게에 없는 리뷰가 붙습니다.
    // ON DELETE CASCADE 가 딸린 행들을 함께 지웁니다.
    const { count } = await tx.arcades.deleteMany({ where: { source: 'seed' } });
    console.log(`\n예시 데이터 ${count}곳 삭제 (딸린 제보·리뷰 포함)`);
  } else if (dropSeed && hitLimit) {
    console.log(
      `\n(가상) 예시 데이터는 남겨 둡니다 — 아직 다 모으지 못했습니다.` +
        `\n   전국 질의를 다 돈 실행에서 함께 지웁니다.`,
    );
  }

  for (const p of places) {
    /*
     * 같은 업체를 알아보는 기준은 **이름 + 주소** 입니다 (placeKey).
     * 네이버가 안정된 장소 ID 를 주지 않기 때문입니다 — 응답의 link 는 대부분
     * 비어 있고, 값이 있어도 업체가 등록한 외부 홈페이지(인스타그램 등)입니다.
     * 실제 응답으로 확인했습니다.
     *
     * source_ref 에는 이름+주소로 만든 네이버 지도 **검색 링크**를 넣습니다.
     * 사람이 영업시간을 확인할 때 열어 볼 주소이자, 같은 업체를 다시 찾는
     * 열쇠를 겸합니다 (이름+주소에서 파생되므로 둘은 같은 기준입니다).
     */
    const ref = p.mapUrl;
    const found = await tx.arcades.findFirst({
      where: { OR: [{ source_ref: ref }, { source: 'naver', name: p.name, address: p.address }] },
      orderBy: { id: 'asc' },
      select: { id: true },
    });

    // 홈페이지는 제 칸(arcades.homepage, migrate-055)으로 갑니다.
    //
    // 예전에는 출처·분류·주소를 `note` 에 이어 붙였는데, note 는 **사용자에게
    // 보이는 한 줄 메모**라서 목록 카드마다 "네이버 지역 검색 · 스포츠,오락>오락실 ·
    // https://…utm_source=qr" 이 그대로 찍혔습니다. 출처는 source/source_ref 가
    // 이미 들고 있으므로 메모에 적을 이유가 없습니다.
    //
    // 네이버는 링크가 없으면 **빈 문자열**을 줍니다(lib/naver-local.ts `item.link ?? ''`). 빈 값은
    // "없음" 으로 읽습니다 — 옛 SQL 의 COALESCE('', homepage) 는 NULL 이 아니라서 사람이 적어 둔
    // 홈페이지를 '' 로 덮었습니다 (2026-09-28 픽스처 실행으로 확인).
    const homepage = p.homepage || null;

    if (found) {
      // 이름·주소·좌표만 갱신합니다. 영업시간과 기종은 사람이 채운 값일 수
      // 있으므로 건드리지 않습니다 — 네이버는 그 정보를 주지 않으니
      // 덮어쓰면 확인해서 넣은 값을 지우는 셈입니다.
      await tx.arcades.update({
        where: { id: found.id },
        data: {
          name: p.name,
          address: p.address,
          lat: p.lat,
          lng: p.lng,
          source: 'naver',
          source_ref: ref,
          // 사람이 적어 둔 홈페이지를 빈 값으로 덮지 않는다 (옛 SQL 의 COALESCE($7, homepage))
          ...(homepage === null ? {} : { homepage }),
          updated_at: new Date(),
        },
      });
      updated += 1;
    } else {
      // 영업시간·전화·메모는 비워 둡니다(스키마 기본값) — 네이버가 주지 않는 정보입니다.
      await tx.arcades.create({
        data: {
          name: p.name,
          address: p.address,
          lat: p.lat,
          lng: p.lng,
          homepage,
          source: 'naver',
          source_ref: ref,
        },
      });
      inserted += 1;
    }
  }
}, BULK_TX_OPTIONS);

const after = await prisma.arcades.groupBy({
  by: ['source'],
  _count: { _all: true },
  orderBy: { source: 'asc' },
});

console.log(`\n반영 완료 — 새로 ${inserted}곳, 갱신 ${updated}곳`);
console.log('현재 arcades 구성:');
for (const r of after) console.log(`  ${r.source ?? '(출처 미기록)'}: ${r._count._all}곳`);
console.log(
  `\n영업시간은 지역 검색 응답에 없어 전부 '정보 없음' 입니다.\n` +
    `source_ref 의 네이버 링크에서 확인해 관리자 화면에서 채워 주세요.\n`,
);
if (hitLimit) {
  console.log(`⏸ 아직 다 모으지 못했습니다. 날짜가 바뀌면 같은 명령으로 이어서 하세요.\n`);
}
process.exit(0);
