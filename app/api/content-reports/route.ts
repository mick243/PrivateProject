import { NextResponse } from 'next/server';
import { fail, handle, parseBody, tooMany } from '@/lib/api-errors';
import { requirePlayer } from '@/lib/auth';
import { createContentReport, ReportError } from '@/lib/moderation';
import { consume, DAY_MS, limitFromEnv, retryAfterLabel } from '@/lib/rate-limit';
import { contentReportInputSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 한 사람이 하루에 낼 수 있는 신고 수 — 신고로 관리자를 도배하지 못하게 */
const DAILY_LIMIT = limitFromEnv('CONTENT_REPORT_DAILY_LIMIT', 20);

/**
 * POST /api/content-reports — 글 · 댓글 · 오락실 리뷰 · 채보 평가 신고 (로그인 필요)
 *
 * 기종 제보(/api/reports — 대기 · 컨디션 · 있어요)와 이름이 겹치지 않게 따로 둡니다.
 * 같은 대상을 다시 신고하면 200 + duplicate 로 답합니다(새 줄을 만들지 않음) — 화면은 "이미
 * 신고했어요" 라고만 말합니다. 접수된 신고는 관리자 화면(/admin)의 신고함으로 갑니다.
 */
async function onPost(request: Request) {
  const guard = await requirePlayer(request);
  if (!guard.ok) return guard.response;

  const body = await parseBody(request, contentReportInputSchema);
  if (!body.ok) return body.response;

  const quota = await consume(`content-report:player:${guard.playerId}`, DAILY_LIMIT, DAY_MS);
  if (!quota.allowed) {
    return tooMany(
      `오늘 신고는 ${quota.limit}건까지 할 수 있어요. ${retryAfterLabel(quota.retryAfterMs)} 뒤에 다시 열려요.`,
      quota.retryAfterMs,
    );
  }

  try {
    const { duplicate } = await createContentReport({ reporterId: guard.playerId, ...body.value });
    return NextResponse.json({ ok: true, duplicate }, { status: duplicate ? 200 : 201 });
  } catch (err) {
    if (err instanceof ReportError) return fail(err.status, err.message);
    throw err;
  }
}

export const POST = handle(onPost);
