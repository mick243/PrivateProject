import { NextResponse } from 'next/server';
import { json } from '@/lib/http';
import { badId, badJson, handle, invalid, parseId } from '@/lib/api-errors';
import { getArcade } from '@/lib/arcades';
import { clientKey, sessionPlayerId } from '@/lib/auth';
import { consume, limitFromEnv, retryAfterLabel, TEN_MINUTES_MS } from '@/lib/rate-limit';
import {
  CabinetNotFoundError,
  createReport,
  listReports,
  MachineNotAtArcadeError,
} from '@/lib/reports';
import { reportInputSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * 제보 시도 제한 (10분 창). 2026-09-13 QA 전까지는 아무 제한이 없었습니다 —
 * 익명이 무한히 "대기 12명+" 를 남길 수 있었고, 그 코멘트가 /live 피드와 챗봇
 * 프롬프트(lib/chat-tools.ts)에 그대로 들어갔습니다.
 *
 *   로그인      → 사람마다 (세션이 키)
 *   익명 + IP   → 주소마다 (신뢰 프록시가 덧붙인 값만 — lib/auth.ts clientKey)
 *   익명, IP 모름 → **오락실마다** 익명 제보 총량. 클라이언트가 고를 수 없는 유일한 키가
 *                 대상 오락실입니다. 한 곳에 몰리는 스팸은 막고, 전국에 흩어진 정상
 *                 제보는 건드리지 않습니다.
 */
const PLAYER_LIMIT = limitFromEnv('REPORT_LIMIT_PER_PLAYER', 30);
const IP_LIMIT = limitFromEnv('REPORT_LIMIT_PER_IP', 15);
const ANON_PER_ARCADE_LIMIT = limitFromEnv('REPORT_LIMIT_ANON_PER_ARCADE', 20);

/** GET /api/arcades/:id/reports?limit=30 — 그 오락실의 최근 제보 */
async function onGet(request: Request, ctx: Ctx) {
  const arcadeId = parseId((await ctx.params).id);
  if (arcadeId === null) return badId();

  const raw = Number(new URL(request.url).searchParams.get('limit'));
  const limit = Number.isInteger(raw) && raw > 0 ? Math.min(raw, 200) : 30;

  const reports = await listReports({ arcadeId, limit });
  return json(request, { reports });
}

/**
 * POST /api/arcades/:id/reports — 제보 등록
 *
 * **로그인 없이도 됩니다** — 여기만 requirePlayer 가 아니라 sessionPlayerId 인
 * 이유입니다. 지나가다 본 것을 알려주는 자리라 가입을 요구하면 제보가 끊깁니다.
 * 대신 익명(playerId = null)은 있어요/없어졌어요 임계값에 세지 않습니다
 * (lib/reports.ts). 로그인했는데 익명으로 남기는 길은 없습니다 — 화면에
 * 그런 선택지가 없고, 있다면 요청이 아니라 화면이 정할 일입니다.
 *
 * 응답에 갱신된 오락실을 함께 실어 보냅니다. 있어요/없어졌어요 제보는
 * 임계값이 차는 순간 보유 기종 목록을 바꾸므로, 클라이언트가 목록을 다시
 * 받아오지 않아도 화면과 DB 가 어긋나지 않게 하기 위해서입니다.
 */
async function onPost(request: Request, ctx: Ctx) {
  const arcadeId = parseId((await ctx.params).id);
  if (arcadeId === null) return badId();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badJson();
  }

  const parsed = reportInputSchema.safeParse(body);
  if (!parsed.success) {
    return invalid(parsed.error);
  }

  if (!(await getArcade(arcadeId))) {
    return NextResponse.json({ error: '오락실을 찾을 수 없습니다' }, { status: 404 });
  }

  const playerId = await sessionPlayerId(request);
  const ip = playerId === null ? clientKey(request) : null;
  const [key, limit] =
    playerId !== null
      ? [`report:player:${playerId}`, PLAYER_LIMIT]
      : ip !== null
        ? [`report:ip:${ip}`, IP_LIMIT]
        : [`report:anon:arcade:${arcadeId}`, ANON_PER_ARCADE_LIMIT];
  const quota = await consume(key, limit, TEN_MINUTES_MS);
  if (!quota.allowed) {
    return NextResponse.json(
      { error: `제보가 너무 잦습니다. ${retryAfterLabel(quota.retryAfterMs)} 뒤에 다시 시도해 주세요` },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(quota.retryAfterMs / 1000)) } },
    );
  }

  try {
    const result = await createReport({
      ...parsed.data,
      arcadeId,
      playerId,
    });
    return NextResponse.json(
      { ...result, arcade: await getArcade(arcadeId) },
      { status: 201 },
    );
  } catch (err) {
    // 둘 다 "화면이 낡았다" 는 뜻이라 409 — 입력이 틀린 게 아니라 그 사이에
    // 보유 기종/대수가 바뀐 것이다.
    if (err instanceof MachineNotAtArcadeError || err instanceof CabinetNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}

/**
 * 핸들러에서 빠져나온 예외를 JSON 500 으로 바꿉니다 (lib/api-errors.ts handle).
 * 감싸지 않으면 본문 없는 500 이 나가고, 클라이언트의 `res.json()` 이 거기서 던집니다.
 */
export const GET = handle(onGet);
export const POST = handle(onPost);
