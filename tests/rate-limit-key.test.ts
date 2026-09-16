import { afterEach, describe, expect, it } from 'vitest';
import { accountKey, clientKey } from '@/lib/auth';

/**
 * 시도 제한의 **키**를 봅니다. 잠금 로직이 아니라 키입니다 — 로직이 맞아도
 * 키를 공격자가 고를 수 있으면 제한이 없는 것과 같습니다.
 *
 * 예전 구현은 `X-Forwarded-For` 의 **첫** 값을 키로 썼습니다. 그 헤더는
 * 클라이언트가 마음대로 보내므로, 헤더만 바꿔 가며 무한히 비밀번호를 시도할 수
 * 있었습니다. 아래 첫 두 테스트가 그 회귀를 막습니다.
 */

const req = (headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/auth/login', { method: 'POST', headers });

afterEach(() => {
  delete process.env.TRUSTED_PROXY_HOPS;
});

describe('clientKey — 위조된 X-Forwarded-For', () => {
  it('프록시가 없으면(기본) IP 를 키로 쓰지 않는다', () => {
    // 세지 않는 것이 **틀린 키로 세는 것보다** 낫습니다. 로그인은 계정 키로 셉니다.
    expect(clientKey(req({ 'x-forwarded-for': '1.2.3.4' }))).toBeNull();
    expect(clientKey(req())).toBeNull();
  });

  it('프록시 1대 뒤에서는 클라이언트가 보낸 값을 무시하고 맨 뒤를 쓴다', () => {
    process.env.TRUSTED_PROXY_HOPS = '1';
    // 프록시가 실제 소켓 주소(203.0.113.9)를 뒤에 붙인 모양.
    const key = clientKey(req({ 'x-forwarded-for': '1.2.3.4, 203.0.113.9' }));
    expect(key).toBe('203.0.113.9');
    expect(key).not.toBe('1.2.3.4');
  });

  it('위조값을 여러 개 끼워 넣어도 흔들리지 않는다', () => {
    process.env.TRUSTED_PROXY_HOPS = '1';
    // 공격자가 체인을 길게 만들어 오른쪽 계산을 흐트리려는 시도.
    expect(
      clientKey(req({ 'x-forwarded-for': '9.9.9.9, 8.8.8.8, 7.7.7.7, 203.0.113.9' })),
    ).toBe('203.0.113.9');
  });

  it('프록시 2대 뒤에서는 오른쪽에서 두 번째를 쓴다', () => {
    process.env.TRUSTED_PROXY_HOPS = '2';
    // nginx → 내부 프록시 → 앱. 체인: [위조, 실제, 내부프록시]
    expect(clientKey(req({ 'x-forwarded-for': '1.2.3.4, 203.0.113.9, 10.0.0.2' }))).toBe(
      '203.0.113.9',
    );
  });

  it('프록시가 있다고 했는데 체인이 짧으면 그 값을 믿지 않는다', () => {
    process.env.TRUSTED_PROXY_HOPS = '2';
    // 프록시를 우회해 직접 들어왔거나 설정이 틀린 경우 — 둘 다 신뢰 불가.
    expect(clientKey(req({ 'x-forwarded-for': '1.2.3.4' }))).toBeNull();
  });

  it('홉 수가 0·음수·쓰레기면 프록시 없음으로 본다', () => {
    for (const v of ['0', '-1', 'abc', '']) {
      process.env.TRUSTED_PROXY_HOPS = v;
      expect(clientKey(req({ 'x-forwarded-for': '1.2.3.4' }))).toBeNull();
    }
  });

  it('x-real-ip 도 신뢰 홉이 있을 때만 본다', () => {
    expect(clientKey(req({ 'x-real-ip': '1.2.3.4' }))).toBeNull();
    process.env.TRUSTED_PROXY_HOPS = '1';
    expect(clientKey(req({ 'x-real-ip': '1.2.3.4' }))).toBe('1.2.3.4');
  });
});

describe('accountKey — 표적은 위조할 수 없다', () => {
  it('대소문자를 접는다 — 안 접으면 카운터를 초기화할 수 있다', () => {
    // DB 의 닉네임 중복 차단이 lower() 기준이라 Admin 과 admin 은 같은 계정입니다.
    // 키가 갈리면 대소문자만 바꿔가며 8회 제한을 무한히 우회합니다.
    expect(accountKey('Admin')).toBe(accountKey('admin'));
    expect(accountKey('ADMIN')).toBe(accountKey('admin'));
  });

  it('앞뒤 공백으로도 갈라지지 않는다', () => {
    expect(accountKey('  admin  ')).toBe(accountKey('admin'));
  });

  it('한글 조합형(NFD)과 완성형(NFC)이 같은 키가 된다', () => {
    // 겉보기가 같은 이름으로 카운터를 나눠 갖지 못하게 — 가입 검증도 NFC 로 맞춥니다.
    expect(accountKey('관리자'.normalize('NFD'))).toBe(accountKey('관리자'.normalize('NFC')));
  });

  it('다른 계정은 다른 키다', () => {
    expect(accountKey('admin')).not.toBe(accountKey('admin2'));
  });

  it('IP 키와 섞이지 않는다', () => {
    process.env.TRUSTED_PROXY_HOPS = '1';
    const ip = clientKey(req({ 'x-forwarded-for': 'admin' }));
    expect(accountKey('admin')).not.toBe(ip);
  });
});
