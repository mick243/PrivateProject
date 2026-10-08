-- 챗봇 도구의 한 쪽 — 조건에 맞는 오락실의 **id 만** 순서대로 골라 셉니다 (lib/arcades.ts pageArcades).
--
-- 기종·기체·컨디션 집계는 하지 않습니다. 고른 id 를 arcadesWithMachines.sql 에 넘겨 그 쪽만 집계합니다
-- — 예전에는 챗봇이 5~8곳을 보여 주려고 조건에 맞는 곳 전부를 집계했습니다 (그 파일 머리말).
--
-- ⚠ `-- ▼ 조건` 과 `-- ▲ 조건` 사이는 arcadesWithMachines.sql 과 **글자까지 같아야** 합니다
--   (tests/typed-sql.test.ts 가 대조). 순서 열쇠도 그 파일의 바깥 ORDER BY 와 같습니다.
--   이 쿼리에서 $6 · $7 은 늘 NULL · 빈 배열입니다 — 블록을 그대로 두려고 받아만 둡니다.
--
-- 파라미터: $1~$7 은 arcadesWithMachines.sql 과 같고, $8 limit · $9 offset.
--
-- @param {Float} $1:lat?
-- @param {Float} $2:lng?
-- @param {Float} $5:radiusKm?
-- @param {Int} $6:arcadeId?
-- @param {Int} $8:limit
-- @param {Int} $9:offset
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
-- 조건 블록이 쉼표로 끝나므로(그 파일에서는 다음 CTE 가 이어집니다) 여기도 CTE 하나를 둡니다.
counted AS (
  SELECT b.id, b.distance_km, b.name, (COUNT(*) OVER ())::int AS total_count
  FROM base b
)
SELECT c.id, c.total_count
FROM counted c
ORDER BY c.distance_km ASC NULLS LAST, c.name ASC, c.id ASC
LIMIT $8::int OFFSET $9::int;
