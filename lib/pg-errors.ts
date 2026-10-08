/**
 * Postgres 에러 코드 판별.
 *
 * 값의 유효성을 DB 제약(FK·CHECK)에 맡긴 곳에서는, 위반을 500 이 아니라
 * 뜻이 통하는 4xx 로 바꿔 줘야 합니다. PGlite 도 실제 Postgres 와 같은
 * SQLSTATE 를 돌려주므로 두 드라이버에서 같이 동작합니다.
 *
 * **Prisma 에서는 에러의 모양이 다릅니다** (앱은 전부 Prisma, scripts/ 는 node-postgres). 같은 위반이
 * 세 가지 모습으로 옵니다 (2026-09-22 실측):
 *
 *   node-postgres  `{ code: '23503', constraint: 'arcade_favorites_player_id_fkey' }`
 *   Prisma raw     `{ code: 'P2010', meta.driverAdapterError.cause:
 *                      { originalCode: '23503', constraint: { index: '…_fkey' } } }`
 *   Prisma Client  `{ code: 'P2003', meta: { field_name … } }` / 중복은 `P2002`
 *
 * 이 파일이 셋을 다 흡수합니다. 그래야 라우트가 엔진을 모른 채로 있을 수 있습니다 —
 * 흡수하지 않으면 엔진을 바꾸는 순간 "없는 오락실 담기" 가 404 대신 **500** 이 됩니다.
 */

type Unknownish = Record<string, unknown>;

function asObject(err: unknown): Unknownish | undefined {
  return typeof err === 'object' && err !== null ? (err as Unknownish) : undefined;
}

function codeOf(err: unknown): string | undefined {
  const code = asObject(err)?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Prisma 가 드라이버 에러를 감싼 자리를 풉니다.
 * `PrismaClientKnownRequestError.meta.driverAdapterError.cause` 에 원본이 들어 있습니다.
 */
function driverCause(err: unknown): Unknownish | undefined {
  const meta = asObject(asObject(err)?.meta);
  const wrapped = asObject(meta?.driverAdapterError);
  return asObject(wrapped?.cause);
}

/**
 * 어느 경로로 왔든 원래의 SQLSTATE. Prisma Client 의 고유 코드(P2002·P2003)는
 * 여기서 대응하는 SQLSTATE 로 바꿔 돌려줍니다 — 부르는 쪽이 코드 하나만 알면 되도록.
 */
export function sqlStateOf(err: unknown): string | undefined {
  const direct = codeOf(err);
  if (direct && /^\d/.test(direct)) return direct; // 23503 처럼 숫자로 시작하면 SQLSTATE

  const original = driverCause(err)?.originalCode;
  if (typeof original === 'string') return original;

  // Prisma Client API 가 직접 내는 코드 (raw 가 아닌 호출)
  if (direct === 'P2002') return '23505';
  if (direct === 'P2003') return '23503';
  return undefined;
}

/**
 * P2025 — Prisma Client 의 `update`·`delete` 가 조건에 맞는 행을 못 찾음.
 *
 * SQL 로는 "0행 갱신" 이라 에러가 아니었지만, Prisma 의 단건 연산은 던집니다. 옛
 * `RETURNING id` 의 "빈 결과 = 없음" 을 그대로 흉내 내려면 이걸 잡아 null/false 로 바꿉니다.
 */
export function isRecordNotFound(err: unknown): boolean {
  return codeOf(err) === 'P2025';
}

/** 23503 — 참조하는 행이 없음 (없는 말머리 / 기종 / 플레이어) */
export function isForeignKeyViolation(err: unknown): boolean {
  return sqlStateOf(err) === '23503';
}

/** 23505 — UNIQUE 위반 */
export function isUniqueViolation(err: unknown): boolean {
  return sqlStateOf(err) === '23505';
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
  const direct = asObject(err)?.constraint;
  if (typeof direct === 'string') return direct;

  // Prisma raw: meta.driverAdapterError.cause.constraint.index
  const constraint = asObject(driverCause(err)?.constraint);
  if (typeof constraint?.index === 'string') return constraint.index;
  // 컬럼 목록으로 주는 경우도 있습니다 (fields: ['nickname'])
  if (Array.isArray(constraint?.fields)) return constraint.fields.join(', ');

  // Prisma Client: meta.target — 인덱스 이름(문자열)이거나 컬럼 배열입니다
  const target = asObject(err)?.meta && asObject(asObject(err)!.meta)!.target;
  if (typeof target === 'string') return target;
  if (Array.isArray(target)) return target.join(', ');
  return undefined;
}
