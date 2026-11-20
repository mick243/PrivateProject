/**
 * 나무위키 「오락실/지역」 문서에서 뽑은 점포별 보유 기종을 우리 오락실의 보유 기종으로 넣습니다.
 *
 *   npm run arcades:namu-machines -- <파일.json>            미리보기 (DB 를 읽기만)
 *   npm run arcades:namu-machines -- <파일.json> --write    넣기 — 없는 것만 더합니다
 *
 * 입력 파일은 lib/namu-machines.ts 의 NamuStore 배열입니다. 나무위키 문서에서 사람이(또는 AI 가
 * 근거 줄을 붙여) 뽑은 것이고, 원문과 근거 줄을 대조해 통과한 것만 담아야 합니다. 둘 곳은
 * localdata/ — 커밋하지 않습니다(.gitignore). 원문은 CC BY-NC-SA 2.0 KR 입니다.
 *
 * 넣는 규칙:
 *   - 폐업(closed)·기종 없는 점포·짝을 못 찾았거나 애매한 점포는 넣지 않고 계획 파일에 남깁니다.
 *     엉뚱한 오락실에 기종을 붙이는 것이 빠뜨리는 것보다 나쁩니다 — 필터·챗봇·제보가 그 값을 믿습니다.
 *   - 이미 있는 (오락실, 기종) 은 건드리지 않습니다. 관리자가 넣었거나 제보로 모인 값이고 기체
 *     컨디션이 붙어 있을 수 있습니다. 나무위키 쪽 대수가 달라도 덮지 않고 계획 파일에 적기만 합니다.
 *   - 새로 넣는 기종의 기체는 대수만큼(모르면 1대 — 제보가 1대로 시작하는 것과 같음, lib/reports.ts).
 *   - 한 오락실에 점포 둘이 짝지어지면 기종은 합치고 대수는 큰 쪽을 씁니다.
 *
 * 계획 파일: <입력>.plan.json — 짝지은 것 · 애매한 것 · 못 찾은 것 · 이미 있던 것.
 *
 * 운영 DB 에는 **이 도구를 같은 데이터 파일로 서버에서 한 번 더** 돌립니다. `data:release` 로는 안
 * 됩니다 — 그쪽은 대상에 없는 **새 오락실**에만 기종을 붙이고, 이미 있는 오락실의 기종은 건드리지
 * 않습니다(lib/data-release.ts applyRelease). 사람이 정한 짝은 id 가 아니라 이름 + 주소(arcadeRef)라
 * DB 마다 id 가 달라도 같은 행을 찾습니다. 데이터 파일은 배포 묶음에 들어가지 않으므로 따로 올립니다.
 */
import fs from 'node:fs';
import { indexArcades, matchStore, type DbArcade, type Match, type NamuStore } from '../lib/namu-machines.ts';
import { BULK_TX_OPTIONS, getPrismaClient } from '../lib/prisma.ts';
import { describeTarget, loadScriptEnv } from '../lib/script-env.ts';

loadScriptEnv();

const args = process.argv.slice(2);
const write = args.includes('--write');
const input = args.find((a) => !a.startsWith('--'));
if (!input) {
  console.error('사용법: npm run arcades:namu-machines -- <파일.json> [--write]');
  process.exit(1);
}

const stores = JSON.parse(fs.readFileSync(input, 'utf8')) as NamuStore[];
const prisma = await getPrismaClient();
console.log(`대상 DB: ${describeTarget()} · ${write ? '넣기' : '미리보기(쓰지 않음)'}`);

const machineRows = await prisma.machines.findMany({ select: { id: true, short_name: true } });
const machineId = new Map(machineRows.map((m) => [m.short_name, m.id]));
const arcades: DbArcade[] = await prisma.arcades.findMany({ select: { id: true, name: true, address: true } });
const arcadeById = new Map(arcades.map((a) => [a.id, a]));
const existing = new Set(
  (await prisma.arcade_machines.findMany({ select: { arcade_id: true, machine_id: true } })).map(
    (r) => `${r.arcade_id}:${r.machine_id}`,
  ),
);
const index = indexArcades(arcades);

interface Planned {
  arcadeId: number;
  arcade: string;
  stores: string[];
  by: string[];
  add: Map<number, number>; // machine_id → 대수
  kept: string[];
}
const plan = new Map<number, Planned>();
const ambiguous: { store: string; doc: string; by: string; candidates: string[] }[] = [];
const unmatched: { store: string; doc: string; addresses: string[] }[] = [];
const skipped: { store: string; doc: string; why: string }[] = [];
const unknownGame = new Set<string>();
let skippedClosed = 0;
let skippedEmpty = 0;

// 1) 점포마다 짝을 찾는다
type Hit = { s: NamuStore; m: Extract<Match, { kind: 'matched' }> };
const hitsByArcade = new Map<number, Hit[]>();
for (const s of stores) {
  if (s.closed) {
    skippedClosed++;
    continue;
  }
  if (s.machines.length === 0) {
    skippedEmpty++;
    continue;
  }
  if (s.skip) {
    skipped.push({ store: s.name, doc: s.doc, why: s.skip });
    continue;
  }
  const m: Match = matchStore(s, arcades, index);
  if (m.kind === 'none') {
    unmatched.push({ store: s.name, doc: s.doc, addresses: s.addresses });
    continue;
  }
  if (m.kind === 'ambiguous') {
    ambiguous.push({ store: s.name, doc: s.doc, by: m.by, candidates: m.candidates.map((id) => `${id} ${arcadeById.get(id)?.name}`) });
    continue;
  }
  hitsByArcade.set(m.arcadeId, [...(hitsByArcade.get(m.arcadeId) ?? []), { s, m }]);
}

// 2) 한 오락실에 점포가 여럿 붙으면 이름이 가장 잘 맞는 쪽만 남긴다.
//    같은 건물의 다른 가게("용산 아이파크몰 팝콘D 스퀘어" → "짱오락실 용산아이파크몰점")가 주소로
//    같이 걸려 들어오기 때문이다. 이름 점수가 비슷하면(1호점 · 2호점) 둘 다 남겨 합친다.
const MERGE_MARGIN = 0.15;
for (const [arcadeId, hits] of hitsByArcade) {
  const best = Math.max(...hits.map((h) => (h.m.by === 'manual' ? 1 : h.m.nameScore)));
  for (const { s, m } of hits) {
    const score = m.by === 'manual' ? 1 : m.nameScore;
    if (score < best - MERGE_MARGIN) {
      skipped.push({ store: s.name, doc: s.doc, why: `같은 주소의 다른 가게로 보임 → ${arcadeById.get(arcadeId)?.name} 에는 다른 점포가 더 잘 맞음` });
      continue;
    }
    const p =
      plan.get(arcadeId) ??
      ({ arcadeId, arcade: arcadeById.get(arcadeId)!.name, stores: [], by: [], add: new Map(), kept: [] } as Planned);
    p.stores.push(`${s.doc} · ${s.name}`);
    p.by.push(`${m.by}(${m.nameScore.toFixed(2)})`);
    addMachines(p, s);
    plan.set(arcadeId, p);
  }
}

/** 점포의 기종을 넣을 목록에 더한다 — 이미 있는 기종은 손대지 않고, 같은 기종은 큰 대수 */
function addMachines(p: Planned, s: NamuStore) {
  for (const g of s.machines) {
    const id = machineId.get(g.game);
    if (id === undefined) {
      unknownGame.add(g.game);
      continue;
    }
    if (existing.has(`${p.arcadeId}:${id}`)) {
      if (!p.kept.includes(g.game)) p.kept.push(g.game);
      continue;
    }
    p.add.set(id, Math.max(p.add.get(id) ?? 0, Math.max(1, g.count ?? 1)));
  }
}

const shortOf = new Map(machineRows.map((m) => [m.id, m.short_name]));
const planned = [...plan.values()];
const toAdd = planned.filter((p) => p.add.size > 0);
const machineCount = toAdd.reduce((n, p) => n + p.add.size, 0);
const cabinetCount = toAdd.reduce((n, p) => n + [...p.add.values()].reduce((a, b) => a + b, 0), 0);

fs.writeFileSync(
  input.replace(/\.json$/, '') + '.plan.json',
  JSON.stringify(
    {
      target: describeTarget(),
      matched: planned.map((p) => ({
        arcadeId: p.arcadeId,
        arcade: p.arcade,
        stores: p.stores,
        by: p.by,
        add: Object.fromEntries([...p.add].map(([id, n]) => [shortOf.get(id), n])),
        alreadyHad: p.kept,
      })),
      ambiguous,
      unmatched,
      skipped,
      unknownGame: [...unknownGame],
    },
    null,
    2,
  ),
);

console.log(
  [
    `점포 ${stores.length} — 폐업 ${skippedClosed} · 기종 없음 ${skippedEmpty}`,
    `짝지음 ${planned.length}곳 (주소 ${planned.filter((p) => p.by.some((b) => b.startsWith('address('))).length} · 주소+이름 ${planned.filter((p) => p.by.some((b) => b.startsWith('address+name'))).length} · 이름 ${planned.filter((p) => p.by.some((b) => b.startsWith('name'))).length} · 사람이 정함 ${planned.filter((p) => p.by.some((b) => b.startsWith('manual'))).length})`,
    `애매 ${ambiguous.length} · 못 찾음 ${unmatched.length} · 건너뜀 ${skipped.length}${unknownGame.size ? ` · 모르는 기종 ${[...unknownGame].join(',')}` : ''}`,
    `넣을 것: 오락실 ${toAdd.length}곳 · 기종 ${machineCount} · 기체 ${cabinetCount} (이미 있던 기종은 건드리지 않음 ${planned.reduce((n, p) => n + p.kept.length, 0)})`,
  ].join('\n'),
);

if (!write) {
  console.log('\n미리보기입니다. 넣으려면 --write 를 붙이세요.');
  process.exit(0);
}

const result = await prisma.$transaction(async (tx) => {
  let machines = 0;
  let cabinets = 0;
  for (const p of toAdd) {
    const rows = [...p.add.keys()].map((id) => ({ arcade_id: p.arcadeId, machine_id: id }));
    machines += (await tx.arcade_machines.createMany({ data: rows, skipDuplicates: true })).count;
    const cabs = [...p.add].flatMap(([id, n]) =>
      Array.from({ length: n }, (_, i) => ({ arcade_id: p.arcadeId, machine_id: id, cabinet_no: i + 1 })),
    );
    cabinets += (await tx.arcade_cabinets.createMany({ data: cabs, skipDuplicates: true })).count;
  }
  return { machines, cabinets };
}, BULK_TX_OPTIONS);

console.log(`\n✔ 넣었습니다 — 기종 ${result.machines} · 기체 ${result.cabinets}`);
process.exit(0);
