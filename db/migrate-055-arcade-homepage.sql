-- ============================================================
-- 055 · 수집 메타데이터를 메모(note)에서 꺼낸다
--
-- 문제: 오락실 수입 스크립트(scripts/import-arcades.ts)가 출처와 홈페이지를
-- `note` 에 문자열로 이어 붙여 넣고 있었다. `note` 는 **사용자에게 보이는 한 줄
-- 메모**("지하 1층. 리듬게임 위주 배치.")라서, 목록 카드마다
--
--     네이버 지역 검색 · 스포츠,오락>오락실 · https://www.instagram.com/3zigu_arcade?igsh=…&utm_source=qr
--
-- 이 그대로 세 줄을 차지하고 있었다 (939곳 중 524곳). 내부 분류 문자열과 추적
-- 파라미터가 붙은 원본 주소가 서비스 화면의 내용이 된 셈이다 (2026-09-13 UX 점검).
--
-- 고치는 방법: 홈페이지는 제 칸(`homepage`)으로 옮기고, 출처는 이미 있는
-- `source`/`source_ref` 로 충분하므로 메모에서 지운다. 사람이 쓴 메모는 패턴이
-- 다르므로 건드리지 않는다.
--
-- 여러 번 실행해도 결과가 같다 — 두 번째부터는 조건에 걸리는 행이 없다.
-- ============================================================

ALTER TABLE arcades ADD COLUMN IF NOT EXISTS homepage TEXT;

-- 1. 메모 끝에 붙어 있던 주소를 homepage 로. 이미 값이 있으면 두 번 덮지 않는다.
UPDATE arcades
   SET homepage = substring(note from '(https?://[^[:space:]]+)[[:space:]]*$')
 WHERE homepage IS NULL
   AND note LIKE '네이버 지역 검색%'
   AND note ~ 'https?://';

-- 2. 출처 문자열만 남은 메모는 비운다 (source 컬럼이 같은 사실을 이미 들고 있다).
UPDATE arcades
   SET note = NULL
 WHERE note LIKE '네이버 지역 검색%';
