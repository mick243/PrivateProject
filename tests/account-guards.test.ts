import { describe, expect, it } from 'vitest';
import { accountAgeWaitMs, MIN_ACCOUNT_AGE_HOURS, newAccountMessage } from '@/lib/account-age';
import { isReservedNickname } from '@/lib/auth';

/**
 * 신뢰를 지키는 두 판정 — 막 만든 계정과 운영자 사칭 이름 (2026-10-28 QA).
 * 라우트가 이 판정을 실제로 쓰는지는 tests/review-vote-guards.test.ts 가 봅니다.
 */

const HOUR = 60 * 60 * 1000;

describe('accountAgeWaitMs — 가입 후 24시간', () => {
  const now = Date.parse('2026-10-28T12:00:00Z');

  it('방금 만든 계정은 거의 하루를 기다린다', () => {
    const created = new Date(now - 5 * 60 * 1000);
    expect(accountAgeWaitMs(created, now)).toBe(MIN_ACCOUNT_AGE_HOURS * HOUR - 5 * 60 * 1000);
  });

  it('하루가 지난 계정은 기다리지 않는다', () => {
    expect(accountAgeWaitMs(new Date(now - 25 * HOUR), now)).toBe(0);
    expect(accountAgeWaitMs(new Date(now - MIN_ACCOUNT_AGE_HOURS * HOUR), now)).toBe(0);
  });

  it('제보와 같은 기준을 쓴다', async () => {
    const reports = await import('@/lib/reports');
    expect(reports.MIN_ACCOUNT_AGE_HOURS).toBe(MIN_ACCOUNT_AGE_HOURS);
  });
});

describe('newAccountMessage — 막힌 이유와 남은 시간', () => {
  it('남은 시간을 시간 단위로 올려 말한다', () => {
    expect(newAccountMessage('투표할', '서열이', 23.2 * HOUR)).toBe(
      '가입 후 24시간이 지나야 투표할 수 있습니다 (약 24시간 남음). ' +
        '막 만든 계정으로 서열이 흔들리지 않게 하려는 제한입니다',
    );
  });

  it('한 시간도 안 남았어도 0시간이라고 하지 않는다', () => {
    expect(newAccountMessage('리뷰를 남길', '평점이', 10 * 60 * 1000)).toContain('약 1시간 남음');
  });
});

describe('isReservedNickname — 운영자로 오해할 수 있는 이름', () => {
  it.each([
    '관리자',
    '운영자',
    '운영 자',
    '공식운영자',
    '운영진1',
    '오락실파인더',
    'admin',
    'Admin_01',
    'the-admin',
    'ADMINISTRATOR',
    'moderator7',
    'staff',
    'staff1',
    '운영staff',
    'kimadmin',
    'arcade.finder',
  ])('%s 는 막는다', (name) => {
    expect(isReservedNickname(name)).toBe(true);
  });

  it.each(['리듬게이머', '사볼고인물', 'badminton', 'stafford_kim', 'qa리듬1028', '관리왕', '운영'])(
    '%s 는 쓸 수 있다',
    (name) => {
      expect(isReservedNickname(name)).toBe(false);
    },
  );
});
