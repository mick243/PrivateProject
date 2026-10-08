import { NextResponse } from 'next/server';
import {
  conflict,
  fail,
  forbidden,
  handle,
  needLogin,
  parseBody,
  readOptionalJson,
  tooMany,
} from '@/lib/api-errors';
import {
  accountStatus,
  changeNickname,
  clearLoginFailures,
  clearSessionCookie,
  deleteAccount,
  getSession,
  loginLockRemainingMs,
  noteLoginFailure,
  setPlayerPassword,
  setSessionCookie,
  verifyPlayerPassword,
} from '@/lib/auth';
import { accountUpdateSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 개인정보 수정 (/account 화면의 짝).
 *
 * 세션 쿠키만으로 이름·비밀번호를 바꿔 주지 않습니다 — 쿠키는 열어 둔 자리에서
 * 집어갈 수 있으므로, **비밀번호를 다시 물어** 본인임을 확인합니다.
 * 예외는 소셜로만 가입해 비밀번호가 아직 없는 계정입니다(대조할 것이 없음).
 * 그 경우 로그인 세션만으로 첫 비밀번호 설정을 허용하고, 그다음부터는 여기도
 * 비밀번호를 요구합니다.
 *
 * 시도 제한은 로그인과 같은 장치를 계정 단위 키로 씁니다 — 세션을 쥔 사람이
 * 비밀번호를 무한정 대입해 보는 것을 막습니다.
 */

const lockKey = (playerId: number) => `account:${playerId}`;

/** 계정 행이 사라진 세션 — 쿠키를 지우며 로그인부터 다시 */
const gone = () => clearSessionCookie(needLogin());

const locked = (lockedMs: number) =>
  tooMany(`시도가 너무 많습니다. ${Math.ceil(lockedMs / 60000)}분 뒤에 다시 해 주세요`, lockedMs);

/**
 * 비밀번호가 있는 계정의 본인 확인. 통과하면 null, 막히면 돌려줄 응답.
 * PUT(수정)과 DELETE(탈퇴)가 같은 순서로 확인합니다 — 잠금 → 입력 → 대조.
 */
async function confirmPassword(playerId: number, currentPassword: string | null | undefined) {
  const key = lockKey(playerId);
  const lockedMs = await loginLockRemainingMs(key);
  if (lockedMs > 0) return locked(lockedMs);
  if (!currentPassword) return fail(400, '현재 비밀번호를 입력해 주세요');
  if (!(await verifyPlayerPassword(playerId, currentPassword))) {
    await noteLoginFailure(key);
    return forbidden('비밀번호가 올바르지 않습니다');
  }
  await clearLoginFailures(key);
  return null;
}

/** GET — 화면을 그리는 데 필요한 것: 지금 이름과 "비밀번호가 있는가" */
async function onGet(request: Request) {
  const session = await getSession(request);
  if (!session) return needLogin();

  const status = await accountStatus(session.playerId);
  if (!status) return gone();
  return NextResponse.json({ nickname: status.nickname, hasPassword: status.hasPassword });
}

/** PUT — `{currentPassword?, nickname?, newPassword?}` → 변경 + 세션 쿠키 재발급 */
async function onPut(request: Request) {
  const session = await getSession(request);
  if (!session) return needLogin();

  // 이 화면은 details 를 보지 않고 error 한 줄을 띄웁니다 — 첫 문구를 머리로 (lib/api-errors.ts).
  const body = await parseBody(request, accountUpdateSchema, 'first');
  if (!body.ok) return body.response;

  const status = await accountStatus(session.playerId);
  if (!status) return gone();

  // 비밀번호가 있는 계정은 반드시 현재 비밀번호로 본인 확인.
  if (status.hasPassword) {
    const denied = await confirmPassword(session.playerId, body.value.currentPassword);
    if (denied) return denied;
  }

  // 닉네임 → 비밀번호 순서. 닉네임이 반려되면(409) 아무것도 바뀌지 않은 상태로
  // 돌려주기 위해 비밀번호는 마지막에 겁니다.
  let user = { ...session, nickname: status.nickname, isAdmin: status.isAdmin };
  if (body.value.nickname !== undefined) {
    const result = await changeNickname(session.playerId, body.value.nickname);
    if (!result.ok) {
      if (result.reason === 'gone') return gone();
      if (result.reason === 'reserved') return conflict('사용할 수 없는 닉네임입니다');
      return conflict('이미 사용 중인 닉네임입니다');
    }
    user = result.user;
  }

  if (body.value.newPassword !== undefined) {
    await setPlayerPassword(session.playerId, body.value.newPassword);
  }

  // 닉네임이 바뀌었을 수 있으므로 세션 쿠키를 새 이름으로 다시 서명합니다.
  return setSessionCookie(NextResponse.json({ user }), user.playerId);
}

/**
 * DELETE — 탈퇴 `{currentPassword?}`.
 *
 * 비밀번호가 있는 계정은 비밀번호로, 소셜만 있는 계정은 세션만으로 확인합니다
 * (PUT 과 같은 규칙 — 대조할 것이 없습니다). 관리자 계정은 여기서 지울 수 없습니다
 * (env 가 근거인 계정이라 다음 로그인에 다시 생깁니다 — lib/auth.ts ensureAdminAccount).
 *
 * 무엇이 함께 지워지는지는 lib/auth.ts deleteAccount 와 /privacy 2항에 적혀 있습니다.
 */
async function onDelete(request: Request) {
  const session = await getSession(request);
  if (!session) return needLogin();

  // 소셜 계정은 본문 없이 보냅니다 — 빈 본문을 {} 로 받습니다.
  const body = await readOptionalJson(request);
  if (!body.ok) return body.response;
  const raw = (body.value as { currentPassword?: unknown }).currentPassword;
  const currentPassword = typeof raw === 'string' ? raw : null;

  const status = await accountStatus(session.playerId);
  if (!status) return gone();
  if (status.isAdmin) {
    return forbidden(
      '관리자 계정은 탈퇴할 수 없습니다. 설정(ADMIN_PASSWORD)에서 계정을 정리해 주세요',
    );
  }

  if (status.hasPassword) {
    const denied = await confirmPassword(session.playerId, currentPassword);
    if (denied) return denied;
  }

  const deleted = await deleteAccount(session.playerId);
  if (!deleted) return gone();
  return clearSessionCookie(new NextResponse(null, { status: 204 }));
}

/**
 * 핸들러에서 빠져나온 예외를 JSON 500 으로 바꿉니다 (lib/api-errors.ts handle).
 * 감싸지 않으면 본문 없는 500 이 나가고, 클라이언트의 `res.json()` 이 거기서 던집니다.
 */
export const GET = handle(onGet);
export const PUT = handle(onPut);
export const DELETE = handle(onDelete);
