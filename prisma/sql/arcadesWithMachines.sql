-- 오락실 목록·단건 + 보유 기종/기체 JSON 집계 (lib/arcades.ts listArcades · getArcade).
--
-- 왜 TypedSQL 인가: haversine 반경 계산, 낱말 분해 검색(bool_and), 기종 AND 필터,
-- 두 뷰(machine_live · cabinet_condition)를 조인한 json_agg 는 Prisma Client API 로
-- 표현되지 않습니다. 원본 SQL 의 측정 근거(CTE 집계 · scope 좁히기)는 lib/arcades.ts 의
-- 주석에 그대로 남아 있습니다.
--
-- 파라미터
--   $1 lat?          반경 검색 기준 위도. NULL 이면 거리도 NULL
--   $2 lng?          기준 경도
--   $3 tokens        검색 낱말 (text[]). **빈 배열 = 필터 없음** — TypedSQL 은 배열을 NULL 로
--                    받는 표기가 없어 길이 0 으로 "없음" 을 나타냅니다
--   $4 machineIds    이 기종을 **모두** 가진 곳만 (int[]). 빈 배열 = 필터 없음
--   $5 radiusKm?     반경(km). lat/lng 와 함께일 때만 뜻이 있습니다
--   $6 arcadeId?     한 곳만 (getArcade). NULL 이면 목록
--   $7 ids           이 id 들만 (int[]). **빈 배열 = 필터 없음** — 챗봇 도구의 한 쪽(pageArcades)
--
-- 쪽 나누기 (2026-09-28 · lib/arcades.ts pageArcades)
--   챗봇은 5곳씩 보여 주는데, 예전에는 조건에 맞는 곳 **전부**(기종 하나로 찾으면 목표 규모에서
--   926곳)의 기종·기체·컨디션을 이 SQL 로 집계한 뒤 앞의 몇 곳만 썼습니다(28.5ms). 이제는
--   prisma/sql/arcadeSearchPage.sql 이 그 쪽의 id 만 고르고, 여기서는 그 id 들만 집계합니다.
--   쪽 나누기를 이 SQL 안에 넣는 두 방법은 재 보고 버렸습니다 — base 에 정렬·창 함수·LIMIT 을
--   붙이면 지도 목록(926곳)이 EXPLAIN 실행 중앙값 +2~3ms, UNION 두 갈래로 나누면 반경 검색이
--   1.4 → 3.0ms (행 수 추정이 바뀌어 cabinet_condition 을 통째로 해시 조인). id 조건 하나는
--   재 봐도 차이가 없었습니다(20.8 → 21.2ms, 1.42 → 1.50ms — 세 번 잰 값끼리의 폭 안).
--
-- ⚠ `-- ▼ 조건` 과 `-- ▲ 조건` 사이는 arcadeSearchPage.sql 과 **글자까지 같아야** 합니다 —
--   다르면 챗봇이 고른 쪽과 지도가 보여 주는 목록이 어긋납니다 (tests/typed-sql.test.ts 가 대조).
--
-- 바뀐 점 (2026-09-22 검토에서 잡은 것)
--   · 기종 AND 필터의 오른쪽을 array_length 대신 **중복을 뺀 개수**로 셉니다 — 같은 id 가
--     두 번 오면(?machines=1,1) 결과가 0 이 되던 버그.
--   · 반경 검색은 **bbox 로 먼저 좁힙니다** — arcades_lat_lng_idx 를 탑니다. haversine 은
--     그 안에서 정밀 필터로만 돕니다 (bbox 는 원을 넉넉히 감싸므로 결과는 같습니다).
--   · a.* 대신 화면이 쓰는 컬럼만 — created_at·source 같은 값이 926행마다 나가고 있었습니다.
--
-- @param {Float} $1:lat?
-- @param {Float} $2:lng?
-- @param {Float} $5:radiusKm?
-- @param {Int} $6:arcadeId?
-- ▼ 조건
WITH scored AS (
  SELECT a.id, a.name, a.address, a.lat, a.lng, a.open_time, a.close_time, a.is_24h,
         a.phone, a.note, a.homepage, a.rating_avg, a.review_count,
         CASE WHEN $1::float8 IS NULL OR $2::float8 IS NULL THEN NULL ELSE
           6371 * acos(LEAST(1, GREATEST(-1,
               cos(radians($1::float8)) * cos(radians(a.lat))
                 * cos(radians(a.lng) - radians($2::float8))
             + sin(radians($1::float8)) * sin(radians(a.lat))
           )))
         END AS distance_km
  FROM arcades a
  WHERE ($6::int IS NULL OR a.id = $6::int)
    AND (cardinality($7::int[]) = 0 OR a.id = ANY($7::int[]))
    -- bbox 선필터. 1도 = 약 111km 인데 110 으로 나눠 조금 넉넉하게 잡습니다.
    AND ($1::float8 IS NULL OR $2::float8 IS NULL OR $5::float8 IS NULL
         OR (a.lat BETWEEN $1::float8 - $5::float8 / 110.0 AND $1::float8 + $5::float8 / 110.0
             AND a.lng BETWEEN $2::float8 - $5::float8 / (110.0 * GREATEST(cos(radians($1::float8)), 0.01))
                           AND $2::float8 + $5::float8 / (110.0 * GREATEST(cos(radians($1::float8)), 0.01))))
    AND (cardinality($3::text[]) = 0
         OR (SELECT bool_and(a.name ILIKE '%' || t || '%' OR a.address ILIKE '%' || t || '%')
             FROM unnest($3::text[]) AS t))
    AND (cardinality($4::int[]) = 0 OR a.id IN (
          SELECT am.arcade_id
          FROM arcade_machines am
          WHERE am.machine_id = ANY($4::int[])
          GROUP BY am.arcade_id
          HAVING COUNT(DISTINCT am.machine_id) = (SELECT COUNT(DISTINCT x) FROM unnest($4::int[]) AS x)
        ))
),
base AS (
  SELECT * FROM scored s
  WHERE $5::float8 IS NULL OR s.distance_km IS NULL OR s.distance_km <= $5::float8
),
-- ▲ 조건
cab_agg AS (
  SELECT c.arcade_id, c.machine_id,
         COUNT(c.id)::int AS cabinet_count,
         json_agg(json_build_object(
           'id',        c.id,
           'cabinetNo', c.cabinet_no,
           'condition', c.condition,
           'conditionSummary', CASE WHEN cc.value IS NULL THEN NULL ELSE json_build_object(
             'value',      cc.value,
             'reports',    COALESCE(cc.reports, 0),
             'reportedAt', cc.reported_at
           ) END)
           ORDER BY c.cabinet_no) AS cabinets
  FROM arcade_cabinets c
  LEFT JOIN cabinet_condition cc ON cc.cabinet_id = c.id
  WHERE c.arcade_id IN (SELECT id FROM base)
  GROUP BY c.arcade_id, c.machine_id
),
mach_agg AS (
  SELECT am.arcade_id,
         json_agg(json_build_object(
           'id',        m.id,
           'name',      m.name,
           'shortName', m.short_name,
           'category',  m.category,
           'cabinetCount', COALESCE(cab.cabinet_count, 0),
           'cabinets',     COALESCE(cab.cabinets, '[]'::json),
           'live', CASE WHEN ml.machine_id IS NULL THEN NULL ELSE json_build_object(
             'waitCount',      ml.wait_count,
             'waitReports',    COALESCE(ml.wait_reports, 0),
             'waitReportedAt', ml.wait_reported_at
           ) END)
           ORDER BY CASE m.category WHEN 'rhythm' THEN 0 ELSE 1 END, m.sort_order, m.id) AS machines
  FROM arcade_machines am
  JOIN machines m ON m.id = am.machine_id
  LEFT JOIN machine_live ml ON ml.arcade_id = am.arcade_id AND ml.machine_id = am.machine_id
  LEFT JOIN cab_agg cab ON cab.arcade_id = am.arcade_id AND cab.machine_id = am.machine_id
  WHERE am.arcade_id IN (SELECT id FROM base)
  GROUP BY am.arcade_id
)
SELECT b.id, b.name, b.address, b.lat, b.lng, b.open_time, b.close_time, b.is_24h,
       b.phone, b.note, b.homepage, b.rating_avg, b.review_count, b.distance_km,
       COALESCE(ma.machines, '[]'::json) AS machines
FROM base b
LEFT JOIN mach_agg ma ON ma.arcade_id = b.id
-- id 로 마지막 순위를 못 박습니다 — 같은 이름이 267곳(66종류) 있어 타이브레이커가 없으면
-- 동명 사이의 순서가 실행계획에 따라 달라집니다 (lib/arcades.ts 주석).
ORDER BY b.distance_km ASC NULLS LAST, b.name ASC, b.id ASC;
