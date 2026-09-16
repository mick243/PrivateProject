/**
 * Postgres 에러 코드 판별.
 *
 * 값의 유효성을 DB 제약(FK·CHECK)에 맡긴 곳에서는, 위반을 500 이 아니라
 * 뜻이 통하는 4xx 로 바꿔 줘야 합니다. PGlite 도 실제 Postgres 와 같은
 * SQLSTATE 를 돌려주므로 두 드라이버에서 같이 동작합니다.
 */
function codeOf(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null
    ? (err as { code?: string }).code
    : undefined;
}

/** 23503 — 참조하는 행이 없음 (없는 말머리 / 기종 / 플레이어) */
export function isForeignKeyViolation(err: unknown): boolean {
  return codeOf(err) === '23503';
}

/** 23505 — UNIQUE 위반 */
export function isUniqueViolation(err: unknown): boolean {
  return codeOf(err) === '23505';
}

/**
 * 위반한 제약(인덱스)의 이름. 한 표에 UNIQUE 가 둘 이상일 때 **무엇이** 겹쳤는지
 * 가려내는 데 씁니다 — 가입 실패 안내가 "아이디 또는 이메일" 로 뭉뚱그려지면
 * 사람이 무엇을 고쳐야 할지 알 수 없습니다.
 *
 * 드라이버가 이름을 주지 않으면 undefined 입니다. 부르는 쪽은 이름이 없을 때도
 * 답을 낼 수 있어야 합니다 (모르면 둘 다 의심하는 문구로).
 */
export function violatedConstraint(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null
    ? (err as { constraint?: string }).constraint
    : undefined;
}
