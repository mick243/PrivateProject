-- 원본: db/migrate-083-moderation.sql
-- 이 파일은 scripts/prisma-migrations-build.mjs 가 생성합니다. 손으로 고치지 마세요 —
-- 내용을 바꾸면 체크섬이 달라져 이미 적용된 DB 에서 migrate deploy 가 거부합니다.

-- ============================================================
-- 083 · 신고 · 차단 · 계정 정지 (content_reports · player_blocks · players.suspended_*)
--
-- ─── 왜 ──────────────────────────────────────────────────
-- 2026-11-20 문제점 조사: 글 · 댓글 · 리뷰 · 채보 평가를 신고할 단추가 없어 신고는 개인정보처리방침의
-- 메일 주소로만 받았고, 다른 사용자를 내 화면에서 가릴 방법도 없었습니다. 관리자가 문제 계정을
-- 막으려면 DB 를 직접 고쳐야 했습니다(players 에 정지 열이 없음).
--
--   content_reports  사용자가 낸 신고. 관리자 화면(/admin)의 신고함이 읽습니다.
--                    대상이 지워져도 무엇을 신고했는지 알 수 있게 발췌(excerpt)를 남깁니다.
--   player_blocks    "이 사람의 글을 내 화면에서 가린다". 상대에게 알리지 않습니다.
--   players.suspended_until · suspended_reason
--                    이 시각까지 로그인 · 글쓰기가 막힙니다(lib/auth.ts getSession).
--
-- ─── 대상 id 에 FK 를 걸지 않는 이유 ────────────────────────
-- 대상이 네 표(posts · post_comments · arcade_reviews · chart_comments)에 흩어져 있고, 대상이
-- 지워진 뒤에도 신고 기록은 남아야 합니다(같은 사람이 반복하는지 봐야 함). 그래서 (종류, id) 로만
-- 가리키고, 누가 쓴 글이었는지는 target_player_id 에 따로 남깁니다.
--
-- ⚠ 여러 번 실행해도 결과가 같아야 합니다. 사용자 데이터 표에 행을 만들지 않습니다.
-- ============================================================

ALTER TABLE players ADD COLUMN IF NOT EXISTS suspended_until TIMESTAMPTZ;
ALTER TABLE players ADD COLUMN IF NOT EXISTS suspended_reason TEXT;

COMMENT ON COLUMN players.suspended_until IS
  '이 시각까지 정지. NULL 이거나 지난 시각이면 정지 아님. 정지 중에는 세션이 통하지 않는다 (migrate-083)';

CREATE TABLE IF NOT EXISTS content_reports (
  id               SERIAL PRIMARY KEY,
  reporter_id      INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  target_type      TEXT    NOT NULL
                   CHECK (target_type IN ('post', 'post_comment', 'arcade_review', 'chart_comment')),
  target_id        INTEGER NOT NULL,
  target_player_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
  reason           TEXT    NOT NULL
                   CHECK (reason IN ('spam', 'abuse', 'privacy', 'false_info', 'other')),
  detail           TEXT    CHECK (detail IS NULL OR char_length(detail) <= 500),
  excerpt          TEXT,
  status           TEXT    NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open', 'actioned', 'dismissed')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at      TIMESTAMPTZ,
  resolved_by      INTEGER REFERENCES players(id) ON DELETE SET NULL,
  -- 한 사람이 같은 대상을 여러 번 신고해 수를 부풀리지 못하게
  UNIQUE (reporter_id, target_type, target_id)
);

CREATE INDEX IF NOT EXISTS content_reports_open_idx
  ON content_reports (created_at DESC) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS content_reports_target_idx
  ON content_reports (target_type, target_id);
CREATE INDEX IF NOT EXISTS content_reports_target_player_idx
  ON content_reports (target_player_id);

CREATE TABLE IF NOT EXISTS player_blocks (
  blocker_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  blocked_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
