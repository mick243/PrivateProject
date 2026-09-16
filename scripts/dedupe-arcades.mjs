/**
 * 같은 오락실이 두 번 들어 있는 것을 찾아 하나로 합칩니다.
 *
 *   npm run arcades:dedupe              무엇을 합칠지만 출력 (기본 · 아무것도 안 바꿈)
 *   npm run arcades:dedupe -- --apply   실제로 합치고 지웁니다
 *
 * ─── 왜 생기나 ───
 * 오락실을 두 곳에서 가져옵니다 — 네이버 지역 검색(526곳)과 공공데이터 인허가
 * (411곳). 같은 가게가 두 원본에 다른 이름으로 있으면 두 행이 됩니다.
 *
 *   고고오락실            대구 달성군 다사읍 달구벌대로 863, 진광타워 106,107호
 *   고고오락실 대실역점    대구 달성군 다사읍 달구벌대로 863 107호 고고오락실
 *
 * 사용자에게는 같은 곳이 목록에 두 번 나오고, 제보도 둘로 갈립니다
 * (2026-09-13 UX 점검).
 *
 * ─── 무엇을 같은 곳으로 보나 ───
 * 주소 문자열은 원본마다 표기가 달라(“863, 진광타워 106,107호” 대 “863 107호 …”)
 * 믿을 수 없고, 좌표만 보면 한 건물에 든 서로 다른 오락실이 묶입니다. 그래서
 * **좌표와 상호를 함께** 보고, 결과를 두 칸으로 나눕니다.
 *
 *   확실      `--apply` 가 합칩니다
 *             · 상호가 (괄호·지점 접미사를 뗀 뒤) 완전히 같고 80m 이내, 또는
 *             · 한쪽 상호가 다른 쪽으로 시작하고 50m 이내
 *   판단 필요  출력만 하고 **건드리지 않습니다** (`--include-unsure` 로 포함)
 *             · 그보다 먼 쌍, 또는 한쪽에만 'N호점' 이 붙은 쌍
 *
 * 'N호점' 을 따로 보는 이유: **연남점과 연남2호점은 다른 가게입니다.** 36m 떨어진
 * 같은 브랜드 두 곳이 실제로 있었습니다. 번호가 서로 다르면 후보에서 아예 뺍니다.
 *
 * 애매한 것은 **묶지 않습니다.** 잘못 합치면 한 곳이 지도에서 사라지는데, 남겨 두면
 * 중복이 보일 뿐입니다. 되돌릴 수 없는 쪽을 피합니다.
 *
 * ─── 합칠 때 무엇이 어디로 가나 ───
 * 남기는 행은 **정보가 많은 쪽**입니다(영업시간·전화·홈페이지·기종·제보 수). 지우는
 * 행에 달린 제보·리뷰·즐겨찾기·보유 기종·기체는 남는 행으로 옮기고, 옮길 수 없는
 * 중복(같은 사람의 같은 오락실 리뷰 등)은 버립니다. 옮긴 뒤에 행을 지웁니다.
 *
 * ⚠ 지우는 작업입니다. `--apply` 전에 `pg_dump -Fc` 로 떠 두세요 (deploy/backup.sh).
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const apply = process.argv.includes('--apply');
/** 판단이 애매한 쌍까지 합친다 — 위 목록을 사람이 직접 보고 나서만 */
const includeUnsure = process.argv.includes('--include-unsure');

// .env.local 에서 DATABASE_URL 만 (다른 스크립트와 같은 방식)
const envFile = path.join(root, '.env.local');
if (!process.env.DATABASE_URL && fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*DATABASE_URL\s*=\s*(.*)\s*$/.exec(line);
    if (m) process.env.DATABASE_URL = m[1].replace(/^["']|["']$/g, '');
  }
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL 이 없습니다.');
  process.exit(2);
}

/** 괄호·지점 접미사·공백·기호를 뗀 상호 ('N호점' 은 branchNo 가 따로 본다) */
function coreName(name) {
  return name
    .replace(/\(.*?\)/g, ' ')
    .replace(/[0-9]+호점?/g, ' ')
    // 흔한 지점 접미사 — 이것만 다르면 같은 브랜드의 같은 자리일 확률이 높다
    .replace(/(본점|지점|점)$/g, ' ')
    .replace(/[\s·,.\-_'"]+/g, '')
    .toLowerCase();
}

/** 'N호점' 의 N — 없으면 null. 연남점과 연남2호점은 다른 가게다 */
function branchNo(name) {
  const m = /([0-9]+)호점/.exec(name);
  return m ? m[1] : null;
}

/**
 * 두 행을 어떻게 볼 것인가.
 *   'skip'   후보가 아니다
 *   'sure'   합쳐도 되는 쌍
 *   'unsure' 사람이 봐야 하는 쌍 (출력만)
 */
function verdict(nameA, nameB, meters) {
  const x = coreName(nameA);
  const y = coreName(nameB);
  if (x.length < 2 || y.length < 2) return 'skip';
  if (!(x === y || x.startsWith(y) || y.startsWith(x))) {
    // 한쪽이 다른 쪽으로 시작하지는 않지만 **브랜드가 같고 아주 가까운** 쌍.
    //   고고오락실 대구죽전점  /  고고오락실 죽전점   (같은 건물 110·111호)
    // 지점명 표기가 원본마다 달라서 생긴다. 자동으로 합치기에는 근거가 약하므로
    // 사람이 보도록 올리기만 한다.
    let i = 0;
    while (i < x.length && i < y.length && x[i] === y[i]) i += 1;
    return i >= 4 && meters <= 50 ? 'unsure' : 'skip';
  }

  const a = branchNo(nameA);
  const b = branchNo(nameB);
  // 번호가 둘 다 있고 다르다 → 다른 가게. 한쪽에만 있다 → 사람이 판단.
  if (a !== null && b !== null && a !== b) return 'skip';
  if ((a === null) !== (b === null)) return 'unsure';

  if (x === y) return meters <= 80 ? 'sure' : 'unsure';
  return meters <= 50 ? 'sure' : 'unsure';
}

/** 후보로 훑는 최대 거리 — 이 밖은 쳐다보지도 않는다 */
const METERS = 120;

const { default: pg } = await import('pg');
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  // 후보: 좌표가 가까운 쌍. 939곳이라 전체 비교(44만 쌍)도 순식간이다.
  const { rows } = await client.query(`
    SELECT a.id AS keep_id, a.name AS keep_name, a.address AS keep_addr,
           b.id AS drop_id, b.name AS drop_name, b.address AS drop_addr,
           round((6371000 * acos(LEAST(1, GREATEST(-1,
             cos(radians(a.lat)) * cos(radians(b.lat)) * cos(radians(b.lng) - radians(a.lng))
             + sin(radians(a.lat)) * sin(radians(b.lat))))))::numeric) AS meters,
           (SELECT count(*) FROM machine_reports r WHERE r.arcade_id = a.id) AS keep_reports,
           (SELECT count(*) FROM machine_reports r WHERE r.arcade_id = b.id) AS drop_reports,
           (SELECT count(*) FROM arcade_machines m WHERE m.arcade_id = a.id) AS keep_machines,
           (SELECT count(*) FROM arcade_machines m WHERE m.arcade_id = b.id) AS drop_machines,
           (a.open_time IS NOT NULL)::int + (a.phone IS NOT NULL)::int + (a.homepage IS NOT NULL)::int AS keep_facts,
           (b.open_time IS NOT NULL)::int + (b.phone IS NOT NULL)::int + (b.homepage IS NOT NULL)::int AS drop_facts
      FROM arcades a
      JOIN arcades b ON b.id > a.id
     WHERE abs(a.lat - b.lat) < 0.002 AND abs(a.lng - b.lng) < 0.002
     ORDER BY a.id, b.id`);

  /** 이미 다른 쌍에서 지우기로 한 행은 다시 쓰지 않는다 (A=B=C 연쇄 방지) */
  const spoken = new Set();
  const merges = [];

  const unsure = [];

  for (const r of rows) {
    if (Number(r.meters) > METERS) continue;
    const how = verdict(r.keep_name, r.drop_name, Number(r.meters));
    if (how === 'skip') continue;
    if (spoken.has(r.keep_id) || spoken.has(r.drop_id)) continue;
    if (how === 'unsure' && !includeUnsure) {
      unsure.push(r);
      continue;
    }

    // 정보가 많은 쪽을 남긴다. 같으면 id 가 작은 쪽(먼저 들어온 행).
    const keepScore = Number(r.keep_facts) * 10 + Number(r.keep_machines) * 5 + Number(r.keep_reports);
    const dropScore = Number(r.drop_facts) * 10 + Number(r.drop_machines) * 5 + Number(r.drop_reports);
    const flip = dropScore > keepScore;
    const keep = flip ? { id: r.drop_id, name: r.drop_name, addr: r.drop_addr } : { id: r.keep_id, name: r.keep_name, addr: r.keep_addr };
    const drop = flip ? { id: r.keep_id, name: r.keep_name, addr: r.keep_addr } : { id: r.drop_id, name: r.drop_name, addr: r.drop_addr };

    spoken.add(keep.id);
    spoken.add(drop.id);
    merges.push({ keep, drop, meters: Number(r.meters) });
  }

  console.log(`대상: ${process.env.DATABASE_URL.replace(/:[^:@]*@/, ':***@')}`);
  console.log(`\n■ 확실 ${merges.length}쌍 — --apply 가 합칩니다`);
  for (const m of merges) {
    console.log(`  남김 #${m.keep.id} ${m.keep.name}`);
    console.log(`  지움 #${m.drop.id} ${m.drop.name}  (${m.meters}m)`);
    console.log(`        ${m.drop.addr}`);
  }
  if (unsure.length) {
    console.log(`\n■ 판단 필요 ${unsure.length}쌍 — 건드리지 않습니다`);
    for (const r of unsure) {
      console.log(`  #${r.keep_id} ${r.keep_name}`);
      console.log(`  #${r.drop_id} ${r.drop_name}  (${r.meters}m)  <- 지점 번호 또는 거리`);
    }
    console.log('  (직접 확인한 뒤 합치려면 --include-unsure 를 함께 주세요)');
  }

  if (!apply) {
    console.log('\n(--apply 를 붙이면 실제로 합칩니다. 먼저 pg_dump -Fc 로 백업하세요.)');
  } else {
    for (const m of merges) {
      await client.query('BEGIN');
      try {
        // 달린 것들을 남는 행으로 옮긴다. 옮기다 중복이 되는 것은 버린다
        // (한 사람이 두 행에 각각 리뷰를 남긴 경우 등 — UNIQUE 제약에 걸린다).
        await client.query(
          `UPDATE machine_reports SET arcade_id = $1 WHERE arcade_id = $2`, [m.keep.id, m.drop.id]);
        await client.query(
          `UPDATE arcade_reviews r SET arcade_id = $1
            WHERE r.arcade_id = $2
              AND NOT EXISTS (SELECT 1 FROM arcade_reviews k
                               WHERE k.arcade_id = $1 AND k.player_id = r.player_id)`,
          [m.keep.id, m.drop.id]);
        await client.query(
          `UPDATE arcade_favorites f SET arcade_id = $1
            WHERE f.arcade_id = $2
              AND NOT EXISTS (SELECT 1 FROM arcade_favorites k
                               WHERE k.arcade_id = $1 AND k.player_id = f.player_id)`,
          [m.keep.id, m.drop.id]);
        await client.query(
          `UPDATE arcade_machines am SET arcade_id = $1
            WHERE am.arcade_id = $2
              AND NOT EXISTS (SELECT 1 FROM arcade_machines k
                               WHERE k.arcade_id = $1 AND k.machine_id = am.machine_id)`,
          [m.keep.id, m.drop.id]);
        // 기체는 (오락실, 기종, 호기) 가 유일하다 — 겹치면 남는 쪽 번호 뒤로 민다.
        await client.query(
          `UPDATE arcade_cabinets c
              SET arcade_id = $1,
                  cabinet_no = c.cabinet_no + COALESCE(
                    (SELECT max(k.cabinet_no) FROM arcade_cabinets k
                      WHERE k.arcade_id = $1 AND k.machine_id = c.machine_id), 0)
            WHERE c.arcade_id = $2`,
          [m.keep.id, m.drop.id]);
        // 비어 있는 정보는 지우는 행에서 채워 온다
        await client.query(
          `UPDATE arcades k
              SET open_time = COALESCE(k.open_time, d.open_time),
                  close_time = COALESCE(k.close_time, d.close_time),
                  is_24h = k.is_24h OR d.is_24h,
                  phone = COALESCE(k.phone, d.phone),
                  homepage = COALESCE(k.homepage, d.homepage),
                  note = COALESCE(k.note, d.note)
             FROM arcades d
            WHERE k.id = $1 AND d.id = $2`,
          [m.keep.id, m.drop.id]);
        await client.query(`DELETE FROM arcades WHERE id = $1`, [m.drop.id]);
        await client.query('COMMIT');
        console.log(`✔ #${m.drop.id} → #${m.keep.id}`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`✗ #${m.drop.id} → #${m.keep.id} — ${err.message}`);
      }
    }
    console.log(`\n완료 — ${merges.length}쌍 처리`);
  }
} finally {
  await client.end();
}
