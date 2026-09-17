import { NextResponse } from 'next/server';
import { consume, DAY_MS, limitFromEnv, retryAfterLabel } from '@/lib/rate-limit';
import {
  buildReviewSummary,
  lookupReviewSummary,
  NotEnoughReviews,
  ReviewSummaryUnavailable,
} from '@/lib/review-summary';
import { REVIEW_SUMMARY_MIN } from '@/lib/review-summary-types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** 하루에 새로 만들 수 있는 요약 수(전체). 리뷰가 바뀐 오락실만 다시 만드니 넉넉합니다 */
const GLOBAL_LIMIT = limitFromEnv('REVIEW_SUMMARY_LIMIT_GLOBAL', 200);

/**
 * GET /api/arcades/:id/reviews/summary — 리뷰 AI 요약.
 *
 * 로그인을 요구하지 않습니다. 리뷰 목록(GET /reviews)이 공개인 것과 같은 이유 —
 * 요약은 그 목록을 접은 것이고, 비로그인이 상세를 열어도 보여야 합니다.
 *
 * GET 인데 저장을 합니다. 저장된 요약이 없거나 낡았을 때 **처음 여는 사람이 만들고
 * 남겨 두는** 캐시라, 그 사람에게 "만들기" 단추를 누르게 하는 것보다 자연스럽습니다.
 * 같은 요청을 다시 보내도 결과는 같습니다(두 번째부터는 저장된 것을 읽습니다).
 *
 * 응답:
 *   { summary: ReviewSummaryView }                       요약 있음
 *   { summary: null, reason: 'not-enough', ... }         리뷰가 모자람 (200 — 정상 상태)
 *   { summary: null, reason: 'limit' | 'unavailable' }   503
 *   { summary: null, reason: 'failed' }                  502 — 모델 호출 실패
 */
export async function GET(_request: Request, ctx: Ctx) {
  const arcadeId = Number((await ctx.params).id);
  if (!Number.isInteger(arcadeId) || arcadeId <= 0) {
    return NextResponse.json({ error: '잘못된 id 입니다' }, { status: 400 });
  }

  const found = await lookupReviewSummary(arcadeId);
  if (found.kind === 'no-arcade') {
    return NextResponse.json({ error: '오락실을 찾을 수 없습니다' }, { status: 404 });
  }
  if (found.kind === 'ready') return NextResponse.json({ summary: found.view });

  const notEnough = () =>
    NextResponse.json({
      summary: null,
      reason: 'not-enough',
      reviewCount: found.reviewCount,
      min: REVIEW_SUMMARY_MIN,
    });
  if (found.reviewCount < REVIEW_SUMMARY_MIN) return notEnough();

  // 여기부터는 모델을 부릅니다 — 하루 상한을 봅니다 (기종 추정의 guess:global 과 같은 장치).
  const all = await consume('review-summary:global', GLOBAL_LIMIT, DAY_MS);
  if (!all.allowed) {
    console.warn(`[review-summary] 전체 일일 한도 ${all.limit} 도달 — ${retryAfterLabel(all.retryAfterMs)} 뒤 해제`);
    return NextResponse.json(
      { summary: null, reason: 'limit', error: '오늘은 AI 요약 요청이 많아 잠시 쉬고 있어요. 내일 다시 열어 주세요.' },
      { status: 503, headers: { 'Retry-After': String(Math.ceil(all.retryAfterMs / 1000)) } },
    );
  }

  try {
    return NextResponse.json({ summary: await buildReviewSummary(arcadeId) });
  } catch (err) {
    if (err instanceof NotEnoughReviews) return notEnough();
    if (err instanceof ReviewSummaryUnavailable) {
      return NextResponse.json({ summary: null, reason: 'unavailable', error: err.message }, { status: 503 });
    }
    // 리뷰 본문은 로그에 남기지 않습니다 — 사용자가 쓴 글입니다. 무엇이 실패했는지만.
    // undici 의 'fetch failed' 는 진짜 이유를 cause 에 숨기므로 그것까지 적습니다.
    const cause = err instanceof Error && err.cause instanceof Error ? ` (cause: ${err.cause.message})` : '';
    console.error(`[review-summary] arcade ${arcadeId}:`, err instanceof Error ? err.name + ': ' + err.message + cause : err);
    return NextResponse.json(
      { summary: null, reason: 'failed', error: '요약을 만들지 못했습니다. 잠시 뒤 다시 열어 주세요.' },
      { status: 502 },
    );
  }
}
