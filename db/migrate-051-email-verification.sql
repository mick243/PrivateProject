-- ============================================================
-- 이메일 인증 — "적어 낸 주소" 를 "확인된 주소" 로
--
-- migrate-050 이 가입할 때 이메일을 받게 했지만, 그 값은 **아무도 확인하지 않은
-- 주소**였습니다. 여기서 확인 절차를 붙입니다.
--
-- ─── UNIQUE 를 통짜에서 '확인된 것만' 으로 바꿉니다 ─────────
--
-- 050 은 lower(email) 전체에 UNIQUE 를 걸었습니다. 확인 절차가 생기고 나서
-- 보니 그 규칙에는 **막다른 길**이 있습니다:
--
--   남의 주소로 먼저 가입해 두면, 진짜 주인은 그 주소로 가입할 수 없습니다.
--   주인이라는 걸 증명할 방법(= 인증 메일)이 가입한 사람에게만 열려 있는데,
--   가입 자체가 막히니 증명할 기회가 영영 오지 않습니다.
--
-- 그래서 UNIQUE 를 **확인된 주소에만** 겁니다. 확인 전에는 같은 주소로 여러
-- 계정이 있을 수 있고, 그중 메일함을 실제로 여는 한 사람만 확인에 성공합니다.
-- 먼저 적어 낸 사람이 아니라 **주인이 이깁니다.**
--
-- 확인 안 된 중복은 남겨 둡니다. 지우고 싶어지지만, 지울 이유가 없습니다 —
-- 비밀번호 찾기는 확인된 주소만 대상으로 하므로(그래서 위 UNIQUE 로 충분합니다)
-- 확인 안 된 사본은 아무 일도 하지 않습니다. 남의 줄을 조용히 비우는 UPDATE 를
-- 두지 않는 편이 사고가 적습니다.
--
-- ─── 토큰은 원문이 아니라 해시로 저장합니다 ─────────────────
--
-- 이 표가 새면 원문 토큰으로 아무 계정이나 인증할 수 있습니다. 비밀번호를
-- 해시로 두는 것과 같은 이유입니다(lib/auth.ts). 대조는 받은 토큰을 다시
-- 해시해서 합니다 — sha256 이면 충분합니다. 비밀번호와 달리 이 값은 사람이
-- 고른 것이 아니라 32바이트 난수라, 사전 공격의 대상이 아니기 때문입니다.
--
--   email      : **보낸 시점의 주소**. 그 사이 주인이 주소를 바꿨다면 옛 링크는
--                무효여야 합니다 — 없으면 지금 주소를 옛 링크로 확인해 버립니다.
--   expires_at : 24시간. 메일함을 하루 안에 한 번은 여는 것을 전제합니다.
--   used_at    : 1회용. 링크가 메일함에 영구히 남는다는 점이 이 칸의 이유입니다.
--   created_at : 재발송 제한의 근거. 표를 따로 두지 않고 여기서 셉니다 —
--                "최근 1시간에 몇 번 보냈나" 가 그대로 답입니다
--                (lib/email-verify.ts). 제한이 없으면 남의 메일함을 우리
--                서버로 두드리는 도구가 됩니다.
--
-- ⚠ 여러 번 실행해도 안전해야 합니다 (lib/db.ts runMigrations 주석 참고).
-- ============================================================

ALTER TABLE players ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;

-- 050 의 통짜 UNIQUE 를 걷어내고 '확인된 것만' 으로 좁힙니다.
DROP INDEX IF EXISTS players_email_lower_idx;

CREATE UNIQUE INDEX IF NOT EXISTS players_email_verified_lower_idx
  ON players (lower(email))
  WHERE email_verified_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS email_verifications (
  token_hash TEXT PRIMARY KEY,
  player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- "이 사람이 최근에 몇 번 받았나" 를 세는 경로 (재발송 제한).
CREATE INDEX IF NOT EXISTS idx_email_verifications_player
  ON email_verifications (player_id, created_at DESC);
