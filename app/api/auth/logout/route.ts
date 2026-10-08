import { NextResponse } from 'next/server';
import { handle } from '@/lib/api-errors';
import { clearSessionCookie } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/auth/logout — 세션 쿠키를 지웁니다 */
async function onPost() {
  return clearSessionCookie(NextResponse.json({ user: null }));
}

export const POST = handle(onPost);
