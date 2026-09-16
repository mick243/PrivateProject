import { NextResponse } from 'next/server';
import { countMachineGuesses, listMachineGuesses } from '@/lib/arcades';
import { clientKey, isAdminRequest, sessionPlayerId } from '@/lib/auth';
import { MachineGuessUnavailable, guessMachines } from '@/lib/machine-guess';
import { consume, DAY_MS, limitFromEnv, retryAfterLabel } from '@/lib/rate-limit';

/** 검색 두 번에 몇 초가 걸립니다. 기본 상한에 걸려 중간에 끊기지 않게 넉넉히 둡니다. */
export const maxDuration = 30;

/**
 * 하루 한도 (고정 창, lib/rate-limit.ts).
 *
 * 출시 전 테스트 기간이라 **누구나** 누를 수 있게 열어 둡니다. 다만 한 번이
 * 구글 검색 1회 + 토큰 2,700여 개라, 여는 대신 세 겹으로 조입니다.
 *
 *   사람마다 / 주소마다  → 하루 1회. 눌러 보기엔 충분하고, 훑기엔 모자랍니다.
 *   익명 + 주소 모름     → 오락실마다. 클라이언트가 고를 수 없는 유일한 키입니다
 *                         (제보 경로와 같은 이유 — reports/route.ts).
 *   전체                 → 하루 총량. 위 둘이 다 새도 청구서가 여기서 멈춥니다.
 *
 * 관리자는 세지 않습니다 — 배치를 돌리는 쪽이고, 한도를 만든 이유가 관리자를
 * 막자는 게 아닙니다. 출시 때 조이려면 env 로 내리면 됩니다.
 */
const PLAYER_LIMIT = limitFromEnv('GUESS_LIMIT_PER_PLAYER', 1);
const IP_LIMIT = limitFromEnv('GUESS_LIMIT_PER_IP', 1);
const ANON_PER_ARCADE_LIMIT = limitFromEnv('GUESS_LIMIT_ANON_PER_ARCADE', 1);
const GLOBAL_LIMIT = limitFromEnv('GUESS_LIMIT_GLOBAL', 200);

function arcadeIdOf(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * GET /api/arcades/:id/guesses — 이 오락실의 보유 기종 **추정**.
 *
 * 확정(arcade_machines)이 아닙니다. 상세 화면이 "이거 맞나요?" 를 물어보기 위한
 * 재료이고, 맞다고 하면 평범한 제보로 들어갑니다 (migrate-061 머리말).
 *
 * 로그인을 요구하지 않습니다 — 읽기이고, 개인에 따라 달라지는 값이 없습니다.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const arcadeId = arcadeIdOf((await params).id);
  if (arcadeId === null) return NextResponse.json({ error: '잘못된 주소입니다' }, { status: 400 });
  return NextResponse.json({ guesses: await listMachineGuesses(arcadeId) });
}

/**
 * POST /api/arcades/:id/guesses — **지금** 이 한 곳을 검색해 추정을 만듭니다.
 *
 * 누구나 하루 1회. 한도 판정 앞에 **이미 추정이 있으면 그대로 돌려주는** 길을
 * 둡니다 — 같은 곳을 두 사람이 눌렀을 때 두 번 검색할 이유가 없고, 한도를
 * 쓰게 하면 "아무 일도 안 일어났는데 오늘 몫을 잃었다" 가 됩니다.
 * 관리자만은 그 경우에도 다시 돕니다. 모델이나 검색 결과가 좋아지면 같은
 * 자리를 갱신하는 것이 맞고, 관리자가 굳이 눌렀다는 것이 그 뜻입니다.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const arcadeId = arcadeIdOf((await params).id);
  if (arcadeId === null) return NextResponse.json({ error: '잘못된 주소입니다' }, { status: 400 });

  const admin = await isAdminRequest(request);

  if (!admin) {
    /*
      이미 검색해 본 곳이면 다시 돌리지 않습니다. **거르기 전의 수**를 봐야 합니다 —
      찾은 것이 전부 이미 확정된 기종이면 보여 줄 목록은 비지만 검색은 분명히
      했습니다. 여기서 빈 목록을 "안 해 봤다" 로 읽으면 그런 곳은 누가 누르든
      매번 새로 검색하고, 매번 같은 답을 얻고, 매번 돈이 나갑니다.
    */
    const searchedBefore = await countMachineGuesses(arcadeId);
    if (searchedBefore > 0) {
      const existing = await listMachineGuesses(arcadeId);
      return NextResponse.json({
        searched: false,
        reused: true,
        found: searchedBefore,
        fresh: existing.length,
        guesses: existing,
      });
    }

    const playerId = await sessionPlayerId(request);
    const ip = playerId === null ? clientKey(request) : null;
    const [key, limit] =
      playerId !== null
        ? [`guess:player:${playerId}`, PLAYER_LIMIT]
        : ip !== null
          ? [`guess:ip:${ip}`, IP_LIMIT]
          : [`guess:anon:arcade:${arcadeId}`, ANON_PER_ARCADE_LIMIT];

    const mine = await consume(key, limit, DAY_MS);
    if (!mine.allowed) {
      return NextResponse.json(
        { error: `오늘 AI 검색 한도(${mine.limit}회)를 다 썼어요. ${retryAfterLabel(mine.retryAfterMs)} 뒤에 다시 열려요.` },
        { status: 429, headers: { 'Retry-After': String(Math.ceil(mine.retryAfterMs / 1000)) } },
      );
    }

    const all = await consume('guess:global', GLOBAL_LIMIT, DAY_MS);
    if (!all.allowed) {
      console.warn(`[guess] 전체 일일 한도 ${all.limit} 도달 — ${retryAfterLabel(all.retryAfterMs)} 뒤 해제`);
      return NextResponse.json(
        { error: '오늘은 AI 검색이 많아 잠시 쉬고 있어요. 내일 다시 시도해 주세요.' },
        { status: 503, headers: { 'Retry-After': String(Math.ceil(all.retryAfterMs / 1000)) } },
      );
    }
  }

  try {
    return NextResponse.json(await guessMachines(arcadeId));
  } catch (err) {
    if (err instanceof MachineGuessUnavailable) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    console.error('[guess] 실패 —', err);
    return NextResponse.json({ error: '검색 중 오류가 났습니다' }, { status: 502 });
  }
}
