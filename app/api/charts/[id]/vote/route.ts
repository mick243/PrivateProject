import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requirePlayer } from '@/lib/auth';
import { NotClearedError, getChartDetail, getSettings, setVote } from '@/lib/tier';
import { formatIssues } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

const schema = z.object({
  value: z.number(),
});

/**
 * 체감 난이도 투표 — `PUT` 으로 남기고 `DELETE` 로 거둡니다 (GUIDELINES §4-1).
 *
 * 예전에는 `POST` 하나가 `{value: number | null}` 을 받아 null 이면 취소였습니다.
 * 값이 실려야 하니 본문은 그대로지만, **취소는 메서드가 말하는 편이 낫습니다** —
 * "없앤다" 를 본문의 null 로 적으면 본문을 못 읽는 길(파싱 실패)에서 의도가 사라집니다.
 * 지침서가 정한 모양과 맞추는 것이기도 합니다 (2026-09-13 전체 점검에서 어긋남 확인).
 *
 * 클리어 기록이 없으면 403. 투표 범위는 tier_settings 에서 읽어 검증하므로
 * 스케일을 바꿔도 코드를 고칠 필요가 없습니다.
 *
 * 누구의 표인지는 세션이 정합니다. 본문의 playerId 를 믿던 동안에는 클리어
 * 게이트가 사실상 없는 것과 같았습니다 — 그 채보를 깬 아무 번호나 적으면
 * 통과했고, 등급이 표의 평균이라 서열표 전체를 혼자 흔들 수 있었습니다.
 */
async function save(
  chartId: number,
  playerId: number,
  value: number | null,
): Promise<NextResponse> {
  try {
    await setVote(playerId, chartId, value);
  } catch (err) {
    if (err instanceof NotClearedError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    throw err;
  }
  return NextResponse.json({ chart: await getChartDetail(chartId, playerId) });
}

function parseChartId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** PUT /api/charts/:id/vote — 투표 `{value}` (같은 값을 여러 번 보내도 결과가 같습니다) */
export async function PUT(request: Request, ctx: Ctx) {
  const chartId = parseChartId((await ctx.params).id);
  if (chartId === null) {
    return NextResponse.json({ error: '잘못된 id 입니다' }, { status: 400 });
  }

  const guard = await requirePlayer(request);
  if (!guard.ok) return guard.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'JSON 본문을 파싱할 수 없습니다' }, { status: 400 });
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: '입력값이 올바르지 않습니다', details: formatIssues(parsed.error) },
      { status: 400 },
    );
  }

  const { value } = parsed.data;
  const { voteMin, voteMax } = await getSettings();
  if (value < voteMin || value > voteMax) {
    return NextResponse.json(
      { error: `투표값은 ${voteMin} ~ ${voteMax} 사이여야 합니다` },
      { status: 400 },
    );
  }

  return save(chartId, guard.playerId, value);
}

/** DELETE /api/charts/:id/vote — 투표 취소 (본문 없음) */
export async function DELETE(request: Request, ctx: Ctx) {
  const chartId = parseChartId((await ctx.params).id);
  if (chartId === null) {
    return NextResponse.json({ error: '잘못된 id 입니다' }, { status: 400 });
  }

  const guard = await requirePlayer(request);
  if (!guard.ok) return guard.response;

  return save(chartId, guard.playerId, null);
}
