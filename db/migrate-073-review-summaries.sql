-- ============================================================
-- 073 · 오락실 리뷰 AI 요약 캐시 (arcade_review_summaries)
--
-- ─── 왜 ──────────────────────────────────────────────────
-- 한 오락실에 리뷰가 다섯 개를 넘으면 상세를 여는 사람마다 다 읽지 않습니다.
-- 좋은 점 · 아쉬운 점 · 기체 상태, 세 줄로 접어 맨 위에 둡니다
-- (lib/review-summary.ts, components/ArcadeReviews.tsx). 대기·혼잡은 지점이 관여할
-- 수 없는 일이라 칸에 넣지 않고, 다른 칸에도 적지 않게 합니다 (lib/review-summary-types.ts).
--
-- ─── 왜 표에 저장하나 ─────────────────────────────────────
-- 요약은 모델 호출 한 번입니다. 상세를 열 때마다 만들면 리뷰 5개짜리 오락실에
-- 스무 명이 드나들며 스무 번 부릅니다. **리뷰가 바뀔 때만 다시 만들고** 그 사이는
-- 여기서 읽습니다 — 기종 추정(arcade_machine_guesses)과 같은 방식.
--
-- ─── review_count 를 같이 적는 이유 ───────────────────────
-- 리뷰가 늘거나 줄면 arcades.review_count 와 어긋나 한 줄 비교로 낡은 것을 알 수
-- 있습니다. 단, **같은 사람이 리뷰를 고치면 수는 그대로**라 이것만으로는 못 잡습니다.
-- 그래서 lib/reviews.ts 가 리뷰를 쓰거나 지울 때 이 표의 줄을 **지웁니다**.
-- 두 장치를 다 두는 이유는 한쪽을 빠뜨린 경로가 생겨도 다른 쪽이 잡기 때문입니다.
--
-- ─── summary 가 JSONB 인 이유 ─────────────────────────────
-- 세 칸(good · bad · condition)이 각각 NULL 일 수 있고, 칸이 늘거나 줄 수 있습니다.
-- 칸마다 열을 두면 늘릴 때마다 ALTER 가 필요합니다. 읽는 쪽은 한 곳뿐입니다.
--
-- ⚠ 여러 번 실행해도 결과가 같아야 합니다 (lib/db.ts runMigrations 주석 참고).
-- ============================================================

CREATE TABLE IF NOT EXISTS arcade_review_summaries (
  -- 오락실 하나에 요약 하나. 오락실이 지워지면 함께 사라집니다.
  arcade_id    INTEGER PRIMARY KEY REFERENCES arcades(id) ON DELETE CASCADE,
  -- 이 요약을 만들 때의 리뷰 수. arcades.review_count 와 다르면 낡은 것.
  review_count INTEGER NOT NULL,
  -- { good, bad, condition } — 각각 문자열 또는 null
  summary      JSONB   NOT NULL,
  -- 어느 모델이 만들었는지. 모델을 바꾸면 옛 요약을 골라 다시 만들 수 있습니다.
  model        TEXT    NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE arcade_review_summaries IS
  '오락실 리뷰 AI 요약 캐시. 리뷰가 바뀌면 지워지고 다음 열람 때 다시 만들어진다.';
