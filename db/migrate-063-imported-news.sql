-- ============================================================
-- 063 · 밖에서 가져온 소식 (imported_news)
--
-- ─── 왜 표가 하나 더 필요한가 ─────────────────────────────
-- 매일 원문을 확인해 **바뀌었으면 앞의 것을 지우고 새것으로 갈아 끼웁니다**
-- (scripts/sync-news.mjs). 그러려면 "무엇이 내가 넣은 글인가" 를 정확히
-- 알아야 합니다.
--
-- 제목이나 본문으로 짐작해서 지우면 언젠가 **사람이 쓴 글을 지웁니다.** 제목이
-- 우연히 같거나, 누가 같은 소식을 손으로 옮겨 적었거나, 규칙을 조금 고친
-- 다음이면 충분히 일어납니다. 그래서 가져온 글은 여기 적어 두고, 지우는 것도
-- **여기 적힌 것만** 지웁니다.
--
-- ─── 원문이 사라지면 ──────────────────────────────────────
-- post_id 는 CASCADE 입니다. 관리자가 글을 직접 지우면 이 줄도 같이 사라지고,
-- 다음 동기화가 그 소식을 다시 가져옵니다. 손으로 지운 것이 되살아나는 셈인데,
-- 되살아나지 않게 하려면 '무시 목록' 이 따로 있어야 합니다 — 지금은 소식이
-- 두 건뿐이라 그 복잡함을 사지 않습니다.
--
-- ⚠ 여러 번 실행해도 결과가 같아야 합니다 (lib/db.ts runMigrations 주석 참고).
-- ============================================================

CREATE TABLE IF NOT EXISTS imported_news (
  -- 어느 사이트에서. 나중에 다른 곳이 붙어도 서로 섞이지 않게.
  source    TEXT    NOT NULL,
  -- 그 사이트가 쓰는 글 번호 (piugame 은 wr_id). 같은 글을 두 번 담지 않는 열쇠입니다.
  source_id TEXT    NOT NULL,
  post_id   INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  -- 원문의 제목·주소를 그대로 적어 둡니다. 제목이 바뀌었는지 비교하는 근거이고,
  -- 글이 지워진 뒤에도 무엇이었는지 남습니다.
  title     TEXT    NOT NULL,
  url       TEXT    NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source, source_id)
);

-- "이 글이 가져온 것인가" 를 글 쪽에서 되묻는 조회.
CREATE INDEX IF NOT EXISTS imported_news_post_idx ON imported_news (post_id);

COMMENT ON TABLE imported_news IS
  '밖에서 가져와 게시판에 넣은 소식. 동기화는 여기 적힌 글만 지운다.';
