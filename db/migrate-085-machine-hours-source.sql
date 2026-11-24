-- ============================================================
-- 085 · 보유 기종 · 영업시간의 출처
--
-- ─── 왜 ──────────────────────────────────────────────────
-- 보유 기종 일부와 영업시간은 나무위키 「오락실/지역」 문서에서 옮겨 옵니다
-- (scripts/import-namu-machines.ts). 원문은 CC BY-NC-SA 2.0 KR 이라 출처를 밝혀야 하는데,
-- 지금까지는 줄마다 출처를 적을 칸이 없어 보유 기종 영역에 "일부는 나무위키" 한 줄만
-- 적었습니다(lib/attribution.ts). 어느 기종이 이용자 제보이고 어느 것이 나무위키인지,
-- 몇 월 며칠 기준인지 알 수 없었습니다.
--
-- 그래서 값을 옮겨 온 곳을 값 옆에 남깁니다.
--   arcade_machines.source_title   예: '나무위키 「오락실/서울/강남」'
--   arcade_machines.source_url     그 문서 주소
--   arcade_machines.source_checked 원문의 '최종 확인일' (없으면 옮겨 온 날)
--   → 셋 다 NULL 이면 이용자 제보 · 관리자 입력입니다. 제보나 관리자가 그 기종을 다시
--     확인해도 출처를 지우지는 않습니다 — 처음 어디서 왔는지는 그대로 사실입니다.
--
--   arcades.hours_text             원문 영업시간 그대로 ("월~토 07:00~24:00 / 일 …").
--                                  open_time · close_time 은 하루 한 구간만 담아
--                                  요일별 · 단서 붙은 시간을 담지 못합니다.
--   arcades.hours_source_title     영업시간 출처 (위와 같은 꼴)
--   arcades.hours_source_url
--   arcades.hours_checked
--   → 관리자가 화면에서 영업시간을 고치면 이 넷을 비웁니다(lib/arcades.ts) — 그때부터는
--     관리자 값이고 나무위키 값이 아닙니다.
--
-- ⚠ 여러 번 실행해도 결과가 같아야 합니다. 행을 만들거나 바꾸지 않습니다.
-- ============================================================

ALTER TABLE arcade_machines ADD COLUMN IF NOT EXISTS source_title   TEXT;
ALTER TABLE arcade_machines ADD COLUMN IF NOT EXISTS source_url     TEXT;
ALTER TABLE arcade_machines ADD COLUMN IF NOT EXISTS source_checked DATE;

ALTER TABLE arcades ADD COLUMN IF NOT EXISTS hours_text         TEXT;
ALTER TABLE arcades ADD COLUMN IF NOT EXISTS hours_source_title TEXT;
ALTER TABLE arcades ADD COLUMN IF NOT EXISTS hours_source_url   TEXT;
ALTER TABLE arcades ADD COLUMN IF NOT EXISTS hours_checked      DATE;
