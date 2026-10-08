import { getPrismaClient } from './prisma';
import { ping } from './typed-sql';

/**
 * DB 가 지금 쿼리에 답하는가 — `/api/health` 가 부릅니다. 답하지 않으면 던집니다.
 *
 * 라우트에 두지 않고 여기로 뺀 이유: 라우트(app/**)는 DB 에 직접 붙지 않고 lib 의 도메인
 * 모듈만 부른다는 규칙이 있고(tests/architecture.test.ts), 2026-09-28 에 재 보니 그 규칙의
 * 예외가 이 한 곳뿐이었습니다. 예외가 하나라도 있으면 규칙을 테스트로 못 박을 수 없습니다.
 */
export async function pingDatabase(): Promise<void> {
  const prisma = await getPrismaClient();
  await prisma.$queryRawTyped(ping());
}
