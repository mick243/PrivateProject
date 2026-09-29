-- 글의 댓글·추천 수 캐시(comment_count · like_count) 재계산 (db/schema-board.sql 의 함수).
-- void 를 돌려주는 함수라 결과 컬럼에 두지 않습니다 — 이유는 recalcChartStats.sql 머리말.
-- @param {Int} $1:postId
SELECT true AS done FROM (SELECT recalc_post_stats($1::int)) AS recalc;
