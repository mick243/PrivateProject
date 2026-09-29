-- 오락실 평점 캐시(rating_avg · review_count) 재계산 (db/schema-community.sql 의 함수).
-- void 를 돌려주는 함수라 결과 컬럼에 두지 않습니다 — 이유는 recalcChartStats.sql 머리말.
-- @param {Int} $1:arcadeId
SELECT true AS done FROM (SELECT recalc_arcade_rating($1::int)) AS recalc;
