-- ============================================================
-- 087 · 오락실 정보 고침 제보 (arcade_info_reports)
--
-- ─── 왜 ──────────────────────────────────────────────────
-- 2026-11-25 기준 개발 DB 926곳 중 영업시간을 아는 곳은 영업시간 문장 110곳 · 24시간 16곳뿐이고,
-- 폐업 · 이전을 알릴 길도 없었습니다. 상세에서 할 수 있는 일이 네이버 지도 · 카카오맵으로
-- 나가는 단추뿐인 곳이 대부분이라, 앱이 지도 앱으로 가는 중간 페이지처럼 보였습니다.
-- 기종은 이미 「이 게임 있어요 / 없어졌어요」 제보(machine_reports)가 있으니, 여기서는
-- 기종 밖의 오락실 정보 — 영업시간 · 문 닫음 · 옮김 · 그 밖 — 를 이용자에게서 받습니다.
--
--   kind = 'hours'   영업시간. hours_text 에 이용자가 쓴 문장 그대로.
--          'closed'  문을 닫았어요 (폐업 · 장기 휴업)
--          'moved'   다른 곳으로 옮겼어요 (detail 에 새 위치)
--          'other'   그 밖에 다른 정보 (detail)
--
-- ─── 바로 반영하지 않습니다 ─────────────────────────────────
-- 관리자가 /admin 에서 보고 정합니다. 영업시간은 승인하면 arcades.hours_text 에 들어가고
-- 출처 칸(migrate-085)에 '이용자 제보' 와 승인한 날이 남습니다. 문 닫음 · 옮김은 오락실을
-- 지우거나 옮기는 일이라 자동으로 하지 않습니다 — 관리자가 확인했다고 표시만 하고, 고치는 것은
-- 기존 수정 · 삭제 화면에서 합니다.
--
-- 같은 사람이 같은 오락실에 같은 종류를 열린 채로 여러 개 쌓지 못하게 부분 유일 색인을 둡니다
-- (다시 보내면 앞의 것을 고칩니다 — lib/arcade-info-reports.ts).
--
-- ⚠ 여러 번 실행해도 결과가 같아야 합니다. 사용자 데이터 표에 행을 만들지 않습니다.
-- ============================================================

CREATE TABLE IF NOT EXISTS arcade_info_reports (
  id           SERIAL PRIMARY KEY,
  arcade_id    INTEGER NOT NULL REFERENCES arcades(id) ON DELETE CASCADE,
  player_id    INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  kind         TEXT    NOT NULL CHECK (kind IN ('hours', 'closed', 'moved', 'other')),
  hours_text   TEXT    CHECK (hours_text IS NULL OR char_length(hours_text) <= 200),
  detail       TEXT    CHECK (detail IS NULL OR char_length(detail) <= 300),
  status       TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'applied', 'dismissed')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at  TIMESTAMPTZ,
  resolved_by  INTEGER REFERENCES players(id) ON DELETE SET NULL,
  -- 영업시간 제보에는 시간이, 나머지에는 설명이 있어야 합니다 (문 닫음은 설명 없이도 됩니다)
  CHECK (kind <> 'hours' OR hours_text IS NOT NULL),
  CHECK (kind NOT IN ('moved', 'other') OR detail IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS arcade_info_reports_open_once
  ON arcade_info_reports (player_id, arcade_id, kind) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS arcade_info_reports_open_idx
  ON arcade_info_reports (created_at DESC) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS arcade_info_reports_arcade_idx
  ON arcade_info_reports (arcade_id);
