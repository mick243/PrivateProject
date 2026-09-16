-- ============================================================
-- 062 · 이모티콘 (emoticons)
--
-- ─── 왜 ──────────────────────────────────────────────────
-- 유니코드 이모지(😀)는 지금도 그냥 쳐서 쓸 수 있습니다 — 막는 코드가 없습니다.
-- 여기 만드는 것은 **그림 이모티콘**입니다. 관리자가 jpg·png·gif 를 올려 두면
-- 사용자는 댓글·리뷰·채보 평가에서 그 목록에서 골라 넣습니다.
--
-- ─── 아무나 올리지 못합니다 ───────────────────────────────
-- 등록은 관리자만입니다. 누구나 올릴 수 있으면 (1) 저장 공간이 사용자 수만큼
-- 늘고 (2) 올라온 그림을 사람이 보기 전에는 무엇인지 알 수 없습니다. 목록이
-- 공용이라 한 장이 모든 화면에 뜹니다 — 검토를 거치지 않을 자리가 아닙니다.
--
-- ─── 본문에는 [[emo:N]] 로 들어갑니다 ─────────────────────
-- 이름이 아니라 **id** 로 가리킵니다. 이름으로 가리키면 이름을 바꾸는 순간
-- 예전 댓글이 전부 깨집니다. 글 본문의 첨부 마커가 [[image:N]] 인 것과 같은
-- 방식입니다 (lib/board.ts syncAttachments).
--
-- ─── 파일은 첨부와 같은 저장소에 ──────────────────────────
-- lib/uploads.ts 의 save() 를 그대로 씁니다(내용 해시가 파일명, 매직 바이트로
-- 형식 판정). 다만 post_images 행으로 만들지 **않습니다** — 그 표는 "글에 붙는
-- 첨부" 이고 post_id 가 NULL 인 행은 언젠가 청소 대상입니다. 이모티콘이 거기
-- 섞이면 청소가 이모티콘을 지웁니다.
--
-- ⚠ 여러 번 실행해도 결과가 같아야 합니다 (lib/db.ts runMigrations 주석 참고).
-- ============================================================

CREATE TABLE IF NOT EXISTS emoticons (
  id          SERIAL PRIMARY KEY,
  -- 고르는 칸에 뜨는 이름이자 대체 텍스트(alt). 그림이 안 뜰 때 남는 유일한 단서입니다.
  name        TEXT        NOT NULL,
  -- lib/uploads.ts 가 만든 파일명(내용 해시). 같은 그림을 두 번 올리면 같은 값입니다.
  storage_key TEXT        NOT NULL,
  mime        TEXT        NOT NULL,
  bytes       INTEGER     NOT NULL,
  -- 올린 관리자. 계정이 사라져도 이모티콘은 남아야 하므로 SET NULL 입니다 —
  -- 지우면 그 사람이 등록한 이모티콘이 든 옛 댓글이 전부 깨집니다.
  created_by  INTEGER     REFERENCES players(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 같은 이름이 둘이면 고르는 칸에서 구분할 수 없습니다.
CREATE UNIQUE INDEX IF NOT EXISTS emoticons_name_key ON emoticons (lower(name));

-- 고르는 칸은 늘 "최근에 올린 것부터" 를 묻습니다.
CREATE INDEX IF NOT EXISTS emoticons_created_idx ON emoticons (created_at DESC);

COMMENT ON TABLE emoticons IS
  '관리자가 등록한 그림 이모티콘. 본문에는 [[emo:id]] 마커로 들어간다.';
