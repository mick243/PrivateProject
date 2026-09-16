import { describe, expect, it } from 'vitest';
import { EMOTICON_TOKEN_RE, emoticonToken } from '@/lib/community-types';

/**
 * 본문에 박히는 `[[emo:N]]` 마커의 계약.
 *
 * 이 정규식이 바뀌면 **이미 저장된 댓글이 전부 깨집니다** — 화면이 마커를 못 찾아
 * `[[emo:3]]` 을 글자 그대로 보여 주게 됩니다. 그래서 모양을 테스트로 못 박습니다.
 */

/** components/EmoticonText.tsx 가 하는 일과 같은 방식 */
const split = (text: string): string[] => text.split(EMOTICON_TOKEN_RE);

describe('이모티콘 마커', () => {
  it('id 로 가리킨다 — 이름이 바뀌어도 옛 댓글이 안 깨지도록', () => {
    expect(emoticonToken(3)).toBe('[[emo:3]]');
  });

  it('split 이 [글자, id, 글자] 로 갈라 준다', () => {
    expect(split('반가워요[[emo:3]]!')).toEqual(['반가워요', '3', '!']);
  });

  it('여러 개도, 마커만 있는 본문도 갈라진다', () => {
    expect(split('[[emo:1]][[emo:22]]')).toEqual(['', '1', '', '22', '']);
  });

  it('마커가 없으면 통째로 한 조각 — 글자를 건드리지 않는다', () => {
    expect(split('그냥 댓글 😀')).toEqual(['그냥 댓글 😀']);
  });

  it('비슷하지만 다른 표기는 마커가 아니다', () => {
    for (const text of ['[[emo:]]', '[[emo:a]]', '[emo:1]', '[[image:1]]']) {
      expect(split(text)).toEqual([text]);
    }
  });

  /**
   * g 플래그가 붙은 정규식은 `test` 가 lastIndex 를 움직입니다. 같은 객체를 여러
   * 컴포넌트가 나눠 쓰므로, 되돌리지 않으면 **두 번째 댓글부터 마커를 못 찾습니다.**
   * EmoticonText 가 test 뒤에 lastIndex 를 0 으로 되돌리는 이유입니다.
   */
  it('test 는 lastIndex 를 남긴다 — 되돌려야 한다', () => {
    expect(EMOTICON_TOKEN_RE.test('[[emo:1]]')).toBe(true);
    expect(EMOTICON_TOKEN_RE.lastIndex).not.toBe(0);
    expect(EMOTICON_TOKEN_RE.test('[[emo:1]]')).toBe(false); // 되돌리지 않으면 이렇게 된다
    EMOTICON_TOKEN_RE.lastIndex = 0;
    expect(EMOTICON_TOKEN_RE.test('[[emo:1]]')).toBe(true);
    EMOTICON_TOKEN_RE.lastIndex = 0;
  });
});
