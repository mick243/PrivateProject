import { json } from '@/lib/http';
import { sessionPlayerId } from '@/lib/auth';
import { handle } from '@/lib/api-errors';
import { DEFAULT_MACHINE_ID, getTierBoard, listGames, listLevels } from '@/lib/tier';
import { UNKNOWN_LEVEL } from '@/lib/tier-types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/tier?machineId=1&mode=S&level=15
 *          (버전이 있는 게임은 &versionId=1 도 — EZ2DJ 1st TRACKS 등)
 *
 * 내 클리어·투표 표시는 세션 주인 기준입니다 (`?playerId=` 는 더 받지 않습니다 —
 * /api/charts/:id 와 같은 이유).
 *
 * versionId/mode/level 은 "희망값"으로 받고, 그 게임에 없는 조합이면 가장 가까운
 * 조합으로 대신 그려 줍니다. 게임을 바꾸면 이전 게임의 모드·레벨이 그대로 넘어오는데
 * (펌프 S15 → 사볼 S15) 그때마다 빈 화면을 보여주는 것보다 낫습니다.
 * 실제로 그려진 조합은 board.versionId / board.mode / board.level 에 실려 나갑니다.
 */
async function onGet(request: Request) {
  const { searchParams } = new URL(request.url);

  const games = await listGames();
  const rawMachine = Number(searchParams.get('machineId'));
  // 서열표가 없는 기종(인형뽑기 등)이 URL 로 들어와도 화면이 비지 않게 기본 게임으로.
  const machineId = games.some((g) => g.machineId === rawMachine)
    ? rawMachine
    : (games[0]?.machineId ?? DEFAULT_MACHINE_ID);

  /**
   * 버전을 구분하지 않는 게임(펌프·사볼)은 versions 가 비어 있어 언제나 null 입니다 —
   * 그 기종의 채보는 version_id 가 NULL 이라 좁힐 것이 없습니다 (migrate-059).
   *
   * 기본값은 **첫 버전**(game_versions.sort_order = 1, 가장 오래된 것)입니다.
   * 게임·레벨 선택기가 전부 "없으면 첫 항목" 이라 같은 규칙으로 둡니다. 최신 버전을
   * 기본으로 하고 싶어지면 여기 한 줄만 고치면 됩니다.
   */
  const versions = games.find((g) => g.machineId === machineId)?.versions ?? [];
  const rawVersion = Number(searchParams.get('versionId'));
  const versionId = versions.some((v) => v.id === rawVersion)
    ? rawVersion
    : (versions[0]?.id ?? null);

  const levels = await listLevels(machineId, versionId);
  const mode = searchParams.get('mode');
  /**
   * 난이도 미상 채보들의 칸은 숫자가 아니라 `level=unknown` 으로 들어옵니다
   * (UNKNOWN_LEVEL). 그 칸의 `levels[].level` 은 null 이라 아래 비교가 그대로 맞고,
   * level 파라미터가 없으면 지금까지처럼 Number(null) = 0 이 되어 첫 조합으로 갑니다.
   */
  const levelRaw = searchParams.get('level');
  const level = levelRaw === UNKNOWN_LEVEL ? null : Number(levelRaw);

  /**
   * 난이도 축인 게임(사볼)은 levels 의 mode 가 전부 null 이라 mode 로 좁힐 수
   * 없습니다. 그래서 레벨만 맞춰 찾고, 못 찾으면 첫 항목으로 갑니다.
   * 모드가 있는 게임(펌프)은 지금까지처럼 (모드, 레벨) → 모드 → 첫 항목 순입니다.
   */
  const byLevel = levels.filter((l) => l.mode === null);
  const wanted =
    (byLevel.length
      ? byLevel.find((l) => l.level === level)
      : (levels.find((l) => l.mode === mode && l.level === level) ??
        levels.find((l) => l.mode === mode))) ?? levels[0];

  if (!wanted) return json(request, { games, machineId, versionId, levels, board: null });

  const board = await getTierBoard({
    machineId,
    versionId,
    mode: wanted.mode,
    level: wanted.level,
    playerId: await sessionPlayerId(request),
  });
  return json(request, { games, machineId, versionId, levels, board });
}

/**
 * 핸들러에서 빠져나온 예외를 JSON 500 으로 바꿉니다 (lib/api-errors.ts handle).
 * 감싸지 않으면 본문 없는 500 이 나가고, 클라이언트의 `res.json()` 이 거기서 던집니다.
 */
export const GET = handle(onGet);
