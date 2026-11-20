import { NextResponse } from 'next/server';
import { fail, handle, tooMany, unavailable } from '@/lib/api-errors';
import { requirePlayer } from '@/lib/auth';
import { createAttachment } from '@/lib/board';
import { consume, HOUR_MS, limitFromEnv, retryAfterLabel } from '@/lib/rate-limit';
import { bytesUploadedLastDay, purgeOrphanAttachments } from '@/lib/upload-housekeeping';
import {
  MAX_UPLOAD_BYTES,
  save,
  UnsupportedUploadError,
  UploadTooLargeError,
} from '@/lib/uploads';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/uploads — 첨부 1개 업로드 (multipart: `file`)
 *
 * 올린 사람은 세션이 정합니다. 이 값은 나중에 "이 첨부를 이 글에 붙일 수 있는
 * 사람인가" 의 근거가 되므로(lib/board.ts syncAttachments 의 `player_id = 올린
 * 사람` 조건), 폼에서 받으면 그 조건이 스스로 무너집니다 — 남이 올린 파일의
 * 번호를 적어 내 글에 붙일 수 있었습니다.
 *
 * 사진과 동영상이 같은 라우트를 씁니다. 종류는 클라이언트가 말하는 것이 아니라
 * 매직 바이트로 판정하므로(lib/uploads.ts detect), 나눠 둘 이유가 없습니다 —
 * 응답의 `mime` 을 보고 화면이 사진/동영상 노드를 고릅니다.
 *
 * 글보다 먼저 올라갑니다. 작성 중에 업로드해 미리보기를 띄우고, 글을 저장할 때
 * 본문의 마커(`[[image:N]]` · `[[video:N]]`)가 그 글에 붙일 첨부를 가리킵니다
 * (lib/board.ts syncAttachments).
 * 저장하지 않고 나가면 post_id 가 NULL 인 채로 남습니다 — 24시간이 지나면 다음 업로드가 덤으로
 * 치웁니다(lib/upload-housekeeping.ts). 글 삭제로 행만 사라진 파일은 scripts/purge-uploads.ts 가 쓸어 냅니다.
 *
 * ─── 상한 (2026-11-20) ────────────────────────────────────────
 * 예전에는 로그인만 하면 횟수 · 용량 제한 없이 올릴 수 있었고, 본문 길이를 밝히지 않은 요청
 * (chunked)은 아래의 사전 검사를 그냥 지나 64MB(Caddy 상한)까지 메모리에 올렸습니다. 1GB 서버에서
 * 동영상 몇 개가 동시에 오면 인스턴스가 먼저 무너집니다. 그래서
 *   1. 길이를 밝히지 않은 요청은 411 — 브라우저의 FormData 업로드는 늘 길이를 보냅니다
 *   2. 한 프로세스가 동시에 받는 업로드는 MAX_CONCURRENT 개 (본문이 메모리에 두 벌 올라가는 경로라
 *      최악의 메모리를 개수로 묶습니다 — 2 × 50MB × 2벌 = 200MB)
 *   3. 사람마다 한 시간 UPLOAD_HOURLY_LIMIT 회, 24시간 UPLOAD_DAILY_MB 메가바이트
 *
 * `image` 필드명도 아직 받습니다 — 예전 화면이 그 이름으로 보냈습니다.
 */
const UPLOAD_HOURLY_LIMIT = limitFromEnv('UPLOAD_HOURLY_LIMIT', 30);
const UPLOAD_DAILY_BYTES = limitFromEnv('UPLOAD_DAILY_MB', 300) * 1024 * 1024;
const MAX_CONCURRENT = limitFromEnv('UPLOAD_MAX_CONCURRENT', 2);

/** 이 프로세스에서 지금 본문을 받고 있는 업로드 수 */
let inFlight = 0;

async function onPost(request: Request) {
  const guard = await requirePlayer(request);
  if (!guard.ok) return guard.response;

  if (inFlight >= MAX_CONCURRENT) {
    return unavailable('지금 올리는 사람이 많아요. 잠시 뒤에 다시 올려 주세요.', 5_000);
  }
  inFlight++;
  try {
    return await receive(request, guard.playerId);
  } finally {
    inFlight--;
  }
}

async function receive(request: Request, playerId: number) {

  /**
   * 본문을 읽기 **전에** 신고된 길이부터 거릅니다.
   *
   * 아래의 `file.size` 검사는 이미 `formData()` 가 전체를 메모리에 올린 뒤입니다.
   * 500MB 를 다 받아 놓고 413 을 주면 제한이 방어 역할을 못 합니다 (2026-09-13 QA).
   * multipart 경계 때문에 본문은 파일보다 조금 큽니다 — 1MB 여유를 둡니다.
   */
  const lengthHeader = request.headers.get('content-length');
  const declared = lengthHeader === null ? NaN : Number(lengthHeader);
  if (!Number.isFinite(declared) || declared < 0) {
    return fail(411, '올릴 파일의 크기를 알 수 없어요. 새로고침한 뒤 다시 올려 주세요');
  }
  if (declared > MAX_UPLOAD_BYTES + 1024 * 1024) {
    return fail(413, new UploadTooLargeError().message);
  }

  // 횟수와 총량은 본문을 받기 **전에** — 거절할 요청의 50MB 를 메모리에 올리지 않게.
  const hourly = await consume(`upload:player:${playerId}`, UPLOAD_HOURLY_LIMIT, HOUR_MS);
  if (!hourly.allowed) {
    return tooMany(
      `한 시간에 첨부는 ${hourly.limit}개까지 올릴 수 있어요. ${retryAfterLabel(hourly.retryAfterMs)} 뒤에 다시 올려 주세요.`,
      hourly.retryAfterMs,
    );
  }
  const used = await bytesUploadedLastDay(playerId);
  if (used + declared > UPLOAD_DAILY_BYTES + 1024 * 1024) {
    return tooMany(
      `하루에 올릴 수 있는 첨부(${Math.round(UPLOAD_DAILY_BYTES / 1024 / 1024)}MB)를 다 썼어요. 내일 다시 올려 주세요.`,
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail(400, '파일을 읽지 못했어요. 다시 올려 주세요');
  }

  const file = form.get('file') ?? form.get('image');
  if (!(file instanceof File)) return fail(400, '올릴 파일을 골라 주세요');

  // 본문을 버퍼로 올리기 전에 신고된 크기부터 거른다 — 제한이 50MB 인데 500MB 를
  // 메모리에 다 읽고 나서 거절하면 제한이 방어 역할을 못 한다.
  // 여기서는 가장 느슨한 상한(동영상)만 보고, 형식별 상한은 save() 가 본다.
  if (file.size > MAX_UPLOAD_BYTES) return fail(413, new UploadTooLargeError().message);

  const buffer = Buffer.from(await file.arrayBuffer());

  try {
    const saved = await save(buffer);
    const attachment = await createAttachment({ playerId, ...saved });
    // 덤으로 버려진 첨부를 조금씩 치운다. 실패해도 업로드는 성공이다.
    void purgeOrphanAttachments({ limit: 20 }).catch((e) => console.warn('[uploads] 고아 첨부 정리 실패 —', e));
    // `image` 로도 함께 내보냅니다 — 응답 모양을 갑자기 좁히지 않기 위한 별칭입니다.
    return NextResponse.json({ file: attachment, image: attachment }, { status: 201 });
  } catch (err) {
    // 형식·크기 위반은 사용자 입력 문제이므로 4xx 로 돌려준다.
    if (err instanceof UnsupportedUploadError) return fail(415, err.message);
    if (err instanceof UploadTooLargeError) return fail(413, err.message);
    throw err;
  }
}

export const POST = handle(onPost);
