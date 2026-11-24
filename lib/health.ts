import { getPrismaClient } from './prisma';
import { ping } from './typed-sql';
import { MAX_UPLOAD_BYTES, probeStorage } from './uploads';

/**
 * 디스크 여유의 하한(바이트). 이보다 적으면 `checks.disk = 'fail'`.
 *
 * 기본값은 가장 큰 첨부(동영상 50MB · lib/uploads.ts)의 4배 — 업로드 몇 건과 DB 쓰기 · 로그가
 * 들어갈 자리입니다. 비율이 아니라 절대량인 이유: 서버 디스크는 작고(NCP Micro), 업로드가
 * 실패하는 순간을 정하는 것은 "몇 % 남았나" 가 아니라 "파일 하나가 들어가나" 입니다.
 * 넉넉한 경보(15% · DiskLow)는 Grafana 가 따로 봅니다(deploy/ncp/monitoring/rules.yml).
 */
export function minFreeBytes(): number {
  const mb = Number(process.env.HEALTH_MIN_FREE_MB);
  return Number.isFinite(mb) && mb > 0 ? mb * 1024 * 1024 : MAX_UPLOAD_BYTES * 4;
}

/** 첨부 저장소 점검 — 둘 다 'ok' | 'fail' (`/api/health` 의 checks 규약) */
export async function checkUploadStorage(): Promise<{ uploads: 'ok' | 'fail'; disk: 'ok' | 'fail' }> {
  const { writable, freeBytes } = await probeStorage();
  return {
    uploads: writable ? 'ok' : 'fail',
    // 여유를 못 읽었으면 실패로 둡니다 — 모르는 것을 괜찮다고 말하지 않습니다.
    disk: freeBytes !== null && freeBytes >= minFreeBytes() ? 'ok' : 'fail',
  };
}

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
