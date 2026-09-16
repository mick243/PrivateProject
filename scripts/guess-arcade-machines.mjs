/**
 * 오락실 보유 기종 **추정** — 검색으로 찾아 arcade_machine_guesses 에 쌓습니다.
 *
 *   npm run arcades:guess -- --list             **대상만 출력** (API 를 부르지 않습니다 · 비용 0)
 *   npm run arcades:guess                       찾아 보고 출력만 (저장 안 함)
 *   npm run arcades:guess -- --apply            실제로 저장
 *
 * 어디를 볼지 고릅니다 (조건은 겹쳐 쓸 수 있고, 모두 만족하는 곳만 대상입니다):
 *   --region 서울,경기      주소에 이 말이 들어간 곳
 *   --name 짱,와와          이름에 이 말이 들어간 곳
 *   --exclude 노리존,키즈   이름·주소에 이 말이 들어가면 **뺍니다**
 *   --ids 42,43,44          이 오락실들만 (다른 조건을 무시합니다)
 *   --limit 50              최대 몇 곳 (기본 10)
 *
 * ─── ⚠ 먼저 --list 로 보세요 ──────────────────────────────
 * 한 곳당 검색 1회 + 토큰 2,700여 개가 듭니다. 923곳을 한 번에 돌리면 검색만
 * 923회입니다(grounding 은 토큰과 별도로 요청당 과금). 무엇을 훑을지 눈으로 보고
 * 범위를 좁힌 뒤 돌리는 것이 훨씬 쌉니다.
 *
 * ─── 왜 배치인가 ──────────────────────────────────────────
 * 챗봇(/api/chat)은 로그인 필수에 하루 40회·전체 2,000회 한도가 걸려 있습니다
 * (lib/rate-limit.ts). 923곳을 그 경로로 돌리면 사용자 몫을 다 먹습니다. 그래서
 * 사람 요청이 아니라 **운영자가 가끔 돌리는 스크립트**로 둡니다.
 *
 * ─── 무엇을 하지 않는가 ───────────────────────────────────
 * arcade_machines(확정)에 쓰지 않고, 제보 임계값에도 세지 않습니다. 기계가 찾은
 * 블로그 글이 현장에서 본 사람과 같은 무게일 수 없습니다 — 추정이 하는 일은
 * 제보 폼을 미리 채워 주는 것까지입니다 (migrate-061 머리말).
 *
 * ─── ⚠ lib/machine-guess.ts 와 같은 규칙입니다 ─────────────
 * 상세 화면의 "AI 로 기종 찾기" 단추는 한 곳만 같은 방식으로 찾습니다. 이 스크립트가
 * .ts 를 import 할 수 없어(Node 가 `@/` 별칭과 확장자 없는 import 를 풀지 못합니다)
 * 프롬프트·매칭 규칙을 옮겨 적었습니다. **한쪽을 고치면 다른 쪽도 고치세요** —
 * 어긋나면 단추로 찾은 것과 배치로 찾은 것이 다른 답을 냅니다.
 *
 * ─── 근거 없는 추정은 버립니다 ────────────────────────────
 * 모델이 기종만 말하고 출처를 못 대면 그 줄은 버립니다. 사람이 "이걸 왜 그렇게
 * 봤나" 를 되짚을 수 없으면 고칠 수도 버릴 수도 없어서, 화면에 세울 수 없습니다.
 *
 * ─── ⚠ 왜 호출이 두 번인가 ────────────────────────────────
 * `responseSchema` 와 `googleSearch` 를 **같이 주면 검색이 돌지 않습니다.**
 * 오류도 나지 않습니다 — 모델이 조용히 기억으로 답하고 스키마에 맞는 JSON 을
 * 돌려줍니다. 실제로 그렇게 짰다가 groundingMetadata 의 검색 질의가 0건인 것을
 * 보고 알았습니다(답에는 '나무위키' 를 출처로 적어 두었는데, 학습 기억이었습니다).
 *
 * 그래서 나눕니다.
 *   1) 검색으로 자유 문장 답을 받고 (여기서만 googleSearch)
 *   2) 그 문장을 스키마로 다시 훑어 구조를 뽑습니다 (여기서는 도구 없음)
 * 배치라 왕복이 하나 느는 것은 문제가 되지 않습니다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { GoogleGenAI, Type } from '@google/genai';

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
const apply = argv.includes('--apply');
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  if (i === -1 || i + 1 >= argv.length) return fallback;
  const n = Number(argv[i + 1]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};
const limit = flag('--limit', 10);
const listOnly = argv.includes('--list');

/** `--region 서울,경기` → ['서울','경기']. 빈 값은 조건 없음(null)으로 둡니다. */
const csv = (name) => {
  const i = argv.indexOf(name);
  if (i === -1 || i + 1 >= argv.length) return null;
  const parts = argv[i + 1]
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  return parts.length ? parts : null;
};
const regions = csv('--region');
const names = csv('--name');
const excludes = csv('--exclude');
const ids = (csv('--ids') ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0);

if (!process.env.DATABASE_URL) {
  console.error('✖ DATABASE_URL 이 없습니다 (.env.local).');
  process.exit(1);
}
if (!process.env.GEMINI_API_KEY) {
  console.error('✖ GEMINI_API_KEY 가 없습니다 (.env.local). 검색 없이는 추정할 수 없습니다.');
  process.exit(1);
}

/** 챗봇과 같은 모델 — 두 곳이 다른 답을 내면 사용자가 먼저 알아챕니다. */
const MODEL = 'gemini-3.7-flash';

const { default: pg } = await import('pg');
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

/*
  리듬게임 기종만 씁니다. 기종 목록을 코드에 적지 않고 DB 에서 읽는 이유는
  관리자가 기종을 더하거나 뺄 때 이 스크립트가 따라 움직여야 하기 때문입니다
  (app/api/chat/route.ts 의 시스템 프롬프트와 같은 규칙).
*/
const { rows: machines } = await db.query(
  `SELECT id, name, short_name FROM machines WHERE category = 'rhythm' ORDER BY id`,
);
/**
 * 모델이 준 이름을 우리 기종 id 로 바꿉니다.
 *
 * 정확 일치로는 거의 다 놓칩니다 — 모델은 "펌프 잇 업 (Pump It Up PHOENIX)" 처럼
 * 버전과 원어를 함께 적습니다. 그래서 **우리 이름이 그 안에 들어 있는지**를 봅니다.
 * 긴 이름부터 보는 이유는 'EZ2AC' 가 'EZ2DJ' 보다 먼저 걸리는 식의 뒤집힘을
 * 막기 위해서입니다 — 짧은 이름이 긴 이름의 일부인 경우가 있습니다.
 */
const NEEDLES = machines
  .flatMap((m) => [m.name, m.short_name].filter(Boolean).map((n) => ({ n: n.toLowerCase(), id: m.id })))
  .sort((a, b) => b.n.length - a.n.length);

function machineIdOf(raw) {
  const t = String(raw ?? '').toLowerCase();
  if (t.trim() === '') return undefined;
  return NEEDLES.find((x) => t.includes(x.n))?.id;
}

/*
  대상: 확정 기종이 **하나도 없는** 곳. 이미 제보가 모인 곳은 건드리지 않습니다 —
  사람이 확인한 것 위에 기계 추정을 덧대면 화면이 무엇을 말하는지 흐려집니다.
  이미 추정이 있는 곳도 건너뜁니다(--id 로는 다시 뽑습니다).
*/
/*
  대상을 고릅니다.

  기본은 "확정 기종이 하나도 없고 추정도 아직 없는 곳" 입니다. 이미 제보가 모인
  곳은 건드리지 않습니다 — 사람이 확인한 것 위에 기계 추정을 덧대면 화면이 무엇을
  말하는지 흐려집니다. 이미 추정이 있는 곳도 건너뛰므로, 나눠서 여러 번 돌리면
  앞서 끝낸 곳을 다시 치지 않고 **이어서** 갑니다.

  --ids 는 그 모든 조건을 무시합니다. 한 곳을 다시 뽑아 보거나 결과를 고쳐 보는
  자리라, "이미 있으니 건너뛴다" 가 방해가 됩니다.

  ⚠ 지역·이름은 **문자열 포함**으로만 봅니다. 뽑기방·키즈존을 자동으로 가려내지는
    않습니다 — 면적이나 기기 수로는 구분이 안 된다는 것이 이미 확인된 사실이고
    (arcades 수입 기록), 이름만으로 단정하면 멀쩡한 오락실이 빠집니다. 대신
    --exclude 로 **사람이** 빼도록 둡니다.
*/
const where = [];
const args = [];
if (ids.length > 0) {
  args.push(ids);
  where.push(`a.id = ANY($${args.length}::int[])`);
} else {
  where.push(`NOT EXISTS (SELECT 1 FROM arcade_machines  m WHERE m.arcade_id = a.id)`);
  where.push(`NOT EXISTS (SELECT 1 FROM arcade_machine_guesses g WHERE g.arcade_id = a.id)`);
  if (regions) {
    args.push(regions);
    where.push(`a.address ILIKE ANY (SELECT '%' || t || '%' FROM unnest($${args.length}::text[]) t)`);
  }
  if (names) {
    args.push(names);
    where.push(`a.name ILIKE ANY (SELECT '%' || t || '%' FROM unnest($${args.length}::text[]) t)`);
  }
  if (excludes) {
    args.push(excludes);
    where.push(
      `NOT (a.name ILIKE ANY (SELECT '%' || t || '%' FROM unnest($${args.length}::text[]) t)` +
        ` OR a.address ILIKE ANY (SELECT '%' || t || '%' FROM unnest($${args.length}::text[]) t))`,
    );
  }
}
args.push(ids.length > 0 ? ids.length : limit);
const { rows: targets } = await db.query(
  `SELECT a.id, a.name, a.address
     FROM arcades a
    WHERE ${where.join(' AND ')}
    ORDER BY a.id
    LIMIT $${args.length}::int`,
  args,
);

const filters = [
  regions && `지역 ${regions.join('·')}`,
  names && `이름 ${names.join('·')}`,
  excludes && `제외 ${excludes.join('·')}`,
  ids.length > 0 && `id ${ids.join(',')}`,
]
  .filter(Boolean)
  .join(' · ');

console.log(
  `대상 ${targets.length}곳` +
    (filters ? ` (${filters})` : '') +
    ` · 기종 후보 ${machines.length}종` +
    (listOnly ? '' : ` · 모델 ${MODEL}`) +
    (listOnly ? '  — 목록만 (API 를 부르지 않습니다)' : apply ? '' : '  (dry-run — 저장하지 않습니다)'),
);
if (targets.length === 0) {
  await db.end();
  process.exit(0);
}

/*
  --list 는 여기서 끝납니다. 돈이 드는 것은 아래 반복문이고, 무엇을 훑을지는
  그 전에 볼 수 있어야 합니다 — 923곳을 모르고 돌리는 일을 막는 것이 이 옵션의 전부입니다.
*/
if (listOnly) {
  for (const a of targets) console.log(`  ${String(a.id).padStart(5)}  ${a.name} · ${a.address ?? ''}`);
  console.log(
    `
예상 — 검색 ${targets.length}회 · 토큰 약 ${(targets.length * 2757).toLocaleString()}개` +
      ' (한 곳당 입력 836 · 출력 1,921 실측치 기준)',
  );
  await db.end();
  process.exit(0);
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

/** 모델이 돌려줄 모양. 자유 문장으로 받으면 파싱이 매번 다릅니다. */
const schema = {
  type: Type.OBJECT,
  properties: {
    machines: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING, description: '기종 이름 (주어진 목록의 표기 그대로)' },
          evidence: { type: Type.STRING, description: '그렇게 본 근거 — 출처 주소나 인용' },
        },
        required: ['name', 'evidence'],
      },
    },
  },
  required: ['machines'],
};

const SYSTEM = `당신은 한국 오락실의 보유 리듬게임 기종을 찾는 조사원입니다.

규칙:
- 아래 목록에 있는 기종만 답하세요. 목록에 없는 게임은 버리세요.
- **검색으로 확인한 것만** 답하세요. 기억이나 추측으로 채우지 마세요.
- 근거(evidence)에는 실제로 본 출처의 주소나 문장을 적으세요. 근거를 댈 수 없으면
  그 기종을 빼세요. 빈 배열이 틀린 답보다 낫습니다.
- 오락실 이름이 비슷한 다른 지점과 헷갈리지 마세요. 주소가 일치하는지 보세요.

기종 목록: ${machines.map((m) => m.name + (m.short_name ? `(${m.short_name})` : '')).join(', ')}`;

let found = 0;
let saved = 0;

for (const a of targets) {
  const where = [a.name, a.address].filter(Boolean).join(' · ');
  let parsed;
  try {
    const res = await ai.models.generateContent({
      model: MODEL,
      contents: `오락실: ${where}\n\n이 오락실에 있는 리듬게임 기종을 찾아 주세요.`,
      config: {
        systemInstruction: SYSTEM,
        tools: [{ googleSearch: {} }],
        responseMimeType: 'application/json',
        responseSchema: schema,
        maxOutputTokens: 2000,
      },
    });
    parsed = JSON.parse(res.text ?? '{}');
  } catch (err) {
    console.log(`  ✖ ${where} — ${err instanceof Error ? err.message : String(err)}`);
    continue;
  }

  // 모델이 준 이름을 우리 기종 id 로 바꿉니다. 목록에 없는 이름은 버립니다 —
  // 프롬프트로 막아 두었지만 지키지 않는 경우가 있고, 그때 조용히 넘어가면
  // 화면에 없는 기종이 뜹니다.
  const rows = [];
  for (const g of parsed.machines ?? []) {
    const id = machineIdOf(g.name);
    const evidence = String(g.evidence ?? '').trim();
    if (id === undefined || evidence === '') continue;
    if (rows.some((r) => r.id === id)) continue;
    rows.push({ id, evidence, label: g.name });
  }

  if (rows.length === 0) {
    console.log(`  · ${where} — 찾지 못함`);
    continue;
  }
  found += rows.length;
  console.log(`  ✔ ${where} — ${rows.map((r) => r.label).join(' · ')}`);

  if (!apply) continue;
  for (const r of rows) {
    await db.query(
      `INSERT INTO arcade_machine_guesses (arcade_id, machine_id, evidence, model)
            VALUES ($1, $2, $3, $4)
       ON CONFLICT (arcade_id, machine_id)
       DO UPDATE SET evidence = EXCLUDED.evidence, model = EXCLUDED.model, created_at = now()`,
      [a.id, r.id, r.evidence.slice(0, 500), MODEL],
    );
    saved += 1;
  }
}

console.log(
  `\n추정 ${found}건` +
    (apply
      ? ` · ${saved}건 저장했습니다.`
      : ' (dry-run — 저장하지 않았습니다. --apply 를 붙이세요.)'),
);
await db.end();
