import { describe, expect, it } from 'vitest';
import {
  isForeignKeyViolation,
  isUniqueViolation,
  sqlStateOf,
  violatedConstraint,
} from '@/lib/pg-errors';

/**
 * 제약 위반을 4xx 로 바꾸는 판정입니다. 여기서 새면 "없는 오락실 담기" 가 404 대신
 * 500 이 되고, 닉네임 중복이 409 대신 500 이 됩니다 — 화면에서는 그냥 "오류" 로 보여
 * 원인을 찾기 어렵습니다.
 *
 * 세 가지 모양을 다 받습니다. 아래 표본은 2026-09-22 에 실제 드라이버가 낸 것을
 * 그대로 옮긴 것입니다 (DB_CLIENT 전환 준비 — docs/PRISMA-MIGRATION.md).
 */

/** node-postgres / PGlite */
const pgError = (code: string, constraint: string) =>
  Object.assign(new Error('pg'), { code, constraint });

/** Prisma raw ($queryRawUnsafe) — 드라이버 에러를 P2010 안에 싸서 준다 */
const prismaRawError = (originalCode: string, index: string) =>
  Object.assign(new Error('Invalid `prisma.$queryRawUnsafe()` invocation'), {
    name: 'PrismaClientKnownRequestError',
    code: 'P2010',
    meta: {
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: { originalCode, kind: 'ConstraintViolation', constraint: { index } },
      },
    },
  });

/** Prisma Client API — 자체 코드로 준다 */
const prismaClientError = (code: string, target: string[] | string) =>
  Object.assign(new Error('prisma client'), {
    name: 'PrismaClientKnownRequestError',
    code,
    meta: { target },
  });

describe('제약 위반 판정 — 세 드라이버', () => {
  it('FK 위반(23503)을 세 모양 모두에서 알아본다', () => {
    expect(isForeignKeyViolation(pgError('23503', 'arcade_favorites_player_id_fkey'))).toBe(true);
    expect(isForeignKeyViolation(prismaRawError('23503', 'arcade_favorites_player_id_fkey'))).toBe(true);
    expect(isForeignKeyViolation(prismaClientError('P2003', 'player_id'))).toBe(true);
  });

  it('UNIQUE 위반(23505)을 세 모양 모두에서 알아본다', () => {
    expect(isUniqueViolation(pgError('23505', 'players_nickname_key'))).toBe(true);
    expect(isUniqueViolation(prismaRawError('23505', 'players_nickname_key'))).toBe(true);
    expect(isUniqueViolation(prismaClientError('P2002', ['nickname']))).toBe(true);
  });

  it('위반한 제약 이름을 꺼낸다 — 가입 실패 안내가 무엇이 겹쳤는지 말할 수 있어야 한다', () => {
    expect(violatedConstraint(pgError('23505', 'players_nickname_key'))).toBe('players_nickname_key');
    expect(violatedConstraint(prismaRawError('23505', 'players_email_key'))).toBe('players_email_key');
    expect(violatedConstraint(prismaClientError('P2002', ['nickname']))).toBe('nickname');
    expect(violatedConstraint(prismaClientError('P2002', 'players_email_key'))).toBe('players_email_key');
  });

  it('다른 오류는 위반이 아니다 — 문법 오류까지 4xx 로 바꾸면 버그가 묻힌다', () => {
    for (const err of [
      pgError('42601', 'x'),
      prismaRawError('42P01', 'x'),
      prismaClientError('P2025', 'x'), // 레코드 없음 — 제약 위반이 아니다
      new Error('평범한 오류'),
      null,
      undefined,
      'string',
    ]) {
      expect(isForeignKeyViolation(err)).toBe(false);
      expect(isUniqueViolation(err)).toBe(false);
    }
  });

  it('SQLSTATE 를 한 가지로 통일해 돌려준다', () => {
    expect(sqlStateOf(pgError('23503', 'x'))).toBe('23503');
    expect(sqlStateOf(prismaRawError('23503', 'x'))).toBe('23503');
    expect(sqlStateOf(prismaClientError('P2003', 'x'))).toBe('23503');
    expect(sqlStateOf(new Error('없음'))).toBeUndefined();
  });

  it('이름을 못 주는 드라이버여도 undefined 로 답한다 (부르는 쪽이 견뎌야 한다)', () => {
    expect(violatedConstraint(Object.assign(new Error('x'), { code: '23505' }))).toBeUndefined();
  });
});
