-- ============================================================
-- 061 · 오락실 보유 기종 **추정** (arcade_machine_guesses)
--
-- ─── 왜 ──────────────────────────────────────────────────
-- 오락실 926곳 중 기종이 등록된 곳이 **3곳**입니다. 나머지 923곳에서는 기종 필터가
-- 아무것도 걸러 내지 못하고, 상세를 열면 "아직 등록된 기종이 없습니다" 만 보입니다.
-- 크라우드소싱이 전제인데 첫 제보가 들어올 이유가 없는 상태입니다 — 빈 화면에
-- "알려 주세요" 만 있으면 아무도 알려 주지 않습니다. **틀릴 수 있는 초안**이 있으면
-- 고치는 일은 합니다.
--
-- ⚠ arcade_machines 에 직접 쓰지 않습니다. 그 표는 "제보 2명이 확인한 것"이라는
--   뜻이고(lib/reports.ts presence_threshold), 추정을 섞으면 기종 필터·개수가
--   조용히 거짓이 됩니다. 추정은 여기 따로 쌓고, 화면은 확정과 **다르게** 그립니다.
--
-- ⚠ 임계값에도 세지 않습니다. 사람 제보 하나를 대신하지 않는다는 뜻입니다 —
--   기계가 찾은 블로그 글이 현장에서 본 사람과 같은 무게일 수 없습니다.
--   추정이 하는 일은 제보 폼을 미리 채워 주는 것까지입니다.
--
-- ─── 한 오락실·한 기종에 한 줄 ────────────────────────────
-- 다시 돌리면 덮어씁니다(ON CONFLICT DO UPDATE). 모델이나 검색 결과가 좋아지면
-- 같은 자리를 갱신하는 것이 맞고, 이력을 쌓을 이유가 없습니다.
--
-- ⚠ 여러 번 실행해도 결과가 같아야 합니다 (lib/db.ts runMigrations 주석 참고).
-- ============================================================

CREATE TABLE IF NOT EXISTS arcade_machine_guesses (
  arcade_id  INTEGER NOT NULL REFERENCES arcades(id)  ON DELETE CASCADE,
  machine_id INTEGER NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  -- 어디서 봤는지. 사람이 "이걸 왜 그렇게 봤나" 를 되짚을 수 있어야 고치거나
  -- 버릴 수 있습니다. 근거 없는 추정은 화면에 세우지 않습니다.
  evidence   TEXT        NOT NULL,
  -- 어느 모델이 언제 뽑았는지. 모델을 바꿨을 때 옛 추정을 골라내는 열쇠입니다.
  model      TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (arcade_id, machine_id)
);

-- 상세 화면은 늘 "이 오락실의 추정" 을 묻습니다 — PK 앞자리가 arcade_id 라
-- 그 조회는 PK 인덱스를 그대로 탑니다. 기종별 역조회는 쓰는 곳이 없어 두지 않습니다.

COMMENT ON TABLE arcade_machine_guesses IS
  'AI 가 찾아낸 보유 기종 추정. 확정(arcade_machines)이 아니며 제보 임계값에 세지 않는다.';
