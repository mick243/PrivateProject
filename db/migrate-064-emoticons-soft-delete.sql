-- ============================================================
-- 064 · 이모티콘 soft delete (emoticons.deleted_at)
--
-- ─── 왜 ──────────────────────────────────────────────────
-- 관리 페이지(/admin/emoticons)가 생기면서 "지운 것을 되살리기" 가 필요해졌습니다.
-- 062 의 DELETE 는 행을 진짜 지웠는데, 그러면 잘못 누른 관리자가 같은 그림을
-- 다시 올려도 **id 가 달라져** 옛 댓글의 [[emo:N]] 은 영영 이름표로 남습니다.
--
-- PetMediSearch-rebuild 의 방식을 따릅니다 — 행은 남기고 deleted_at 만 찍고,
-- 읽는 쿼리마다 `deleted_at IS NULL` 을 붙입니다. 되살리기는 그 값을 NULL 로.
--
-- ─── 이름 UNIQUE 는 "살아 있는 것" 사이에서만 ─────────────
-- 지운 이모티콘의 이름을 새 이모티콘이 쓸 수 있어야 합니다. 062 의 전체 UNIQUE 를
-- 부분 인덱스로 바꿉니다. 인덱스 이름(emoticons_name_key)은 그대로 둡니다 —
-- lib/emoticons.ts createEmoticon 이 그 이름으로 충돌을 알아봅니다.
--
-- ⚠ 여러 번 실행해도 결과가 같아야 합니다 (lib/db.ts runMigrations 주석 참고).
-- ============================================================

ALTER TABLE emoticons ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

DROP INDEX IF EXISTS emoticons_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS emoticons_name_key
  ON emoticons (lower(name)) WHERE deleted_at IS NULL;

-- 고르는 칸(살아 있는 것만, 최근순)과 관리 페이지(상태별 목록+COUNT)가 같은 인덱스를 탑니다.
DROP INDEX IF EXISTS emoticons_created_idx;
CREATE INDEX IF NOT EXISTS emoticons_live_created_idx
  ON emoticons (deleted_at, created_at DESC, id DESC);

COMMENT ON COLUMN emoticons.deleted_at IS
  '관리자가 목록에서 뺀 시각. NULL 이면 고르는 칸에 뜬다. 되살리면 다시 NULL.';
