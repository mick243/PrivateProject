-- 원본: db/migrate-084-password-resets.sql
-- 이 파일은 scripts/prisma-migrations-build.mjs 가 생성합니다. 손으로 고치지 마세요 —
-- 내용을 바꾸면 체크섬이 달라져 이미 적용된 DB 에서 migrate deploy 가 거부합니다.

-- ============================================================
-- 084 · 비밀번호 찾기 (password_resets)
--
-- ─── 왜 ──────────────────────────────────────────────────
-- 2026-11-20 UX 시험 A-3: 가입할 때 이메일이 "비밀번호를 잊었을 때 쓰여요" 라고 했는데
-- 로그인 화면에 찾는 길이 없었고 /forgot-password · /reset-password 는 404 였습니다.
-- 확인된 이메일(migrate-051 · players_email_verified_lower_idx — 확인된 주소는 계정 하나)로
-- 1회용 링크를 보내 새 비밀번호를 정하게 합니다 (lib/password-reset.ts).
--
-- 모양은 email_verifications(051)와 같습니다.
--   token_hash : 토큰 원문이 아니라 sha256. 표가 새도 그 값으로 남의 비밀번호를 바꿀 수 없게
--   email      : 보낸 시점의 주소. 그 사이 주소가 바뀌거나 확인이 풀리면 옛 링크는 무효
--   expires_at : 1시간. 인증 메일(24시간)보다 짧습니다 — 이 링크는 계정을 통째로 넘깁니다
--   used_at    : 1회용
--   created_at : 재발송 제한의 근거 (분당 1통 · 시간당 5통, 표를 따로 두지 않고 여기서 셉니다)
--
-- ⚠ 여러 번 실행해도 결과가 같아야 합니다. 사용자 데이터 표에 행을 만들지 않습니다.
-- ============================================================

CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- "이 사람이 최근에 몇 번 받았나" 를 세는 경로 (재발송 제한).
CREATE INDEX IF NOT EXISTS idx_password_resets_player
  ON password_resets (player_id, created_at DESC);
