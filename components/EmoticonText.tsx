'use client';

import { EMOTICON_TOKEN_RE } from '@/lib/community-types';
import { useEmoticons } from '@/lib/use-emoticons';

/**
 * 본문의 `[[emo:N]]` 자리를 그림으로 바꿔 그립니다.
 *
 * 나머지 글자는 손대지 않고 그대로 React 텍스트 노드로 넣습니다 —
 * `dangerouslySetInnerHTML` 을 쓰지 않는다는 이 저장소의 규칙(components/RichText.tsx
 * 머리말)이 여기서도 그대로입니다. 사용자가 쓴 글자는 언제나 글자입니다.
 *
 * 지운 이모티콘, 또는 목록이 아직 안 온 상태에서는 `[[emo:3]]` 이 그대로
 * 보이지 않게 이름표(`[이모티콘]`)로 둡니다 — 남의 댓글이 내부 표기로
 * 깨져 보이는 것보다 낫습니다.
 */
export default function EmoticonText({ text }: { text: string }) {
  const emoticons = useEmoticons();
  if (!EMOTICON_TOKEN_RE.test(text)) {
    // test 는 g 플래그에서 lastIndex 를 움직이므로 되돌려 둡니다.
    EMOTICON_TOKEN_RE.lastIndex = 0;
    return <>{text}</>;
  }
  EMOTICON_TOKEN_RE.lastIndex = 0;

  // split 에 캡처 그룹이 있는 정규식을 주면 [글자, id, 글자, id, …] 로 나옵니다.
  const parts = text.split(EMOTICON_TOKEN_RE);

  return (
    <>
      {parts.map((part, i) => {
        if (i % 2 === 0) return part;
        const emoticon = emoticons.find((e) => String(e.id) === part);
        if (!emoticon) return <span key={i} className="emoticon-gone">[이모티콘]</span>;
        return (
          // eslint-disable-next-line @next/next/no-img-element -- 크기가 제각각인
          // 사용자 업로드라 next/image 의 고정 width·height 가 맞지 않습니다.
          <img
            key={i}
            className="emoticon"
            src={emoticon.url}
            alt={emoticon.name}
            title={emoticon.name}
            loading="lazy"
          />
        );
      })}
    </>
  );
}
