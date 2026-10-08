-- ============================================================
-- 081 · 운영 알림 (ops_alerts) · 관리자 푸시 구독 (ops_push_subscriptions)
--
-- ─── 왜 ──────────────────────────────────────────────────
-- 실서버 감시는 Grafana Cloud 가 하고(deploy/ncp/README.md §9), 알림은 메일로만 왔습니다.
-- 메일로는 "디스크 여유가 15% 아래" 한 줄만 와서, 무엇을 먼저 볼지는 서버에 들어가서야
-- 알았습니다. Grafana 가 알림을 웹훅으로도 보내게 하고(POST /api/ops/alerts), 앱이 받아
-- 여기 적은 뒤 Gemini 로 "무슨 일 · 영향 · 먼저 볼 것" 을 붙입니다(lib/ops-alert-summary.ts).
-- 관리자 화면의 종 아이콘(components/OpsAlertBell.tsx)이 이 표를 읽고, 구독한 기기로
-- 웹 푸시를 보냅니다(lib/ops-push.ts).
--
-- ─── 한 줄이 무엇인가 ─────────────────────────────────────
-- Grafana 는 알림마다 지문(fingerprint — 규칙 + 라벨)을 줍니다. 같은 지문이 다시 울리면
-- 시작 시각(starts_at)이 달라집니다. 그래서 (지문, 시작 시각) 하나가 "한 번의 사건" 이고,
-- 울림(firing) → 풀림(resolved) 은 같은 줄의 status 를 바꿉니다. Grafana 는 울리는 동안
-- 같은 알림을 몇 시간마다 다시 보내는데, 그때는 줄이 늘지 않습니다.
--
-- ─── 사용자 데이터가 아닙니다 ─────────────────────────────
-- 운영 중에 생기는 값이라 데이터 릴리스에 담지 않습니다(lib/data-release.ts EXCLUDED).
-- 30일이 지난 줄은 받는 쪽이 지웁니다(lib/ops-alerts.ts).
--
-- ⚠ 여러 번 실행해도 결과가 같아야 합니다.
-- ============================================================

CREATE TABLE IF NOT EXISTS ops_alerts (
  id            SERIAL PRIMARY KEY,
  -- Grafana 가 준 알림 지문. 규칙과 라벨이 같으면 같은 값입니다.
  fingerprint   TEXT        NOT NULL,
  -- 이번에 울리기 시작한 때. 지문과 함께 한 사건을 가립니다.
  starts_at     TIMESTAMPTZ NOT NULL,
  status        TEXT        NOT NULL CHECK (status IN ('firing', 'resolved')),
  -- 규칙 이름(labels.alertname)과 심각도(labels.severity) — 목록에서 바로 쓰려고 꺼내 둡니다.
  alertname     TEXT        NOT NULL,
  severity      TEXT,
  -- 규칙에 적어 둔 설명(annotations.summary). 요약을 못 만들면 이것을 보여 줍니다.
  summary       TEXT,
  -- 라벨 전체와, 규칙이 평가한 값({"A": 0.14, …}) — 요약의 근거가 됩니다.
  labels        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  eval_values   JSONB,
  -- Grafana 의 규칙 화면 주소.
  generator_url TEXT,
  -- 풀린 때. 울리는 동안은 NULL.
  ends_at       TIMESTAMPTZ,
  -- Gemini 요약 { headline, impact, causes[], checks[{ what, command }] }. 만들지 못했으면 NULL 이고 그 까닭이 ai_error.
  ai_summary    JSONB,
  ai_error      TEXT,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 마지막으로 상태가 바뀐 때 — 목록의 정렬 기준.
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 관리자가 목록을 연 때. 울림 → 풀림으로 바뀌면 다시 NULL(새 소식)이 됩니다.
  read_at       TIMESTAMPTZ,
  UNIQUE (fingerprint, starts_at)
);

CREATE INDEX IF NOT EXISTS ops_alerts_updated_idx ON ops_alerts (updated_at DESC);

COMMENT ON TABLE ops_alerts IS
  'Grafana 알림 웹훅으로 받은 운영 알림과 그 AI 요약 — (fingerprint, starts_at) 하나가 한 사건 (migrate-081)';

CREATE TABLE IF NOT EXISTS ops_push_subscriptions (
  id          SERIAL PRIMARY KEY,
  -- 구독한 관리자. 계정이 지워지면 구독도 사라지고, 관리자 권한을 떼면 보내는 쪽이 거릅니다.
  player_id   INTEGER     NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  -- 브라우저가 준 푸시 주소와 암호화 키(PushSubscription.toJSON()). 주소가 곧 기기입니다.
  endpoint    TEXT        NOT NULL UNIQUE,
  p256dh      TEXT        NOT NULL,
  auth        TEXT        NOT NULL,
  -- 어느 기기인지 목록에서 알아보려고 (예: "iPhone · Safari").
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_ok_at  TIMESTAMPTZ,
  -- 연달아 실패한 수. 브라우저가 구독을 버렸다고 답하면(404 · 410) 바로 지우고, 그 밖의 실패가
  -- 쌓이면(lib/ops-push.ts) 지웁니다.
  failures    INTEGER     NOT NULL DEFAULT 0
);

COMMENT ON TABLE ops_push_subscriptions IS
  '운영 알림을 받을 관리자 기기의 웹 푸시 구독 (migrate-081)';
