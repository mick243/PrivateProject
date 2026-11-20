import { describe, expect, it } from 'vitest';
import { normalizeDoc, toPlainText, type RichDoc } from '@/lib/rich-text';
import {
  decodeEntities,
  docToText,
  htmlToBlocks,
  piuNoticeContentHtml,
} from '@/scripts/news-body.mjs';

/**
 * 공식 공지 본문 → 우리 글 문서 (scripts/news-body.mjs).
 *
 * 가장 중요한 것은 **만든 문서가 앱의 normalizeDoc 을 지나도 그대로인가** 입니다. 앱은 글을
 * 그릴 때 문서를 다시 거르므로(lib/board.ts docFromDb), 여기서 허용되지 않는 모양을 만들면
 * 화면에서 조용히 사라집니다. 평문(posts.body)도 앱의 toPlainText 와 같아야 검색 ·
 * 미리보기가 어긋나지 않습니다.
 *
 * 예시 HTML 은 piugame.com 공지의 **구조만** 흉내 낸 것입니다(그누보드 스킨 · 편집기 마크업).
 * 원문 글을 테스트에 옮겨 싣지 않습니다.
 */

const BASE = 'https://piugame.com/phoenix2_notice?&wr_id=1';

function docOf(html: string): RichDoc {
  const { blocks } = htmlToBlocks(html, BASE);
  return { type: 'doc', content: blocks } as RichDoc;
}

/** 앱이 다시 걸러도 같은지, 평문 투영이 같은지 — 모든 예시에 거는 공통 확인 */
function expectAppCompatible(doc: RichDoc) {
  expect(normalizeDoc(doc)).toEqual(doc);
  expect(docToText(doc)).toBe(toPlainText(doc));
}

const PAGE = `
<div class="board_st board_view_top"><p class="tit">제목</p></div>
<div class="board_st board_view_middle editor-css">
  <script>if (a < b && c > d) { $("#x").show(); }</script>
  <script>var s = "</div>";</script>
  <p>첫 문단</p>
</div>
<div class="board_btn_wrap flex space"><a href="javascript:history.back()">목록</a></div>
<p>본문 밖</p>`;

describe('piuNoticeContentHtml — 본문 칸만 떼어 낸다', () => {
  it('board_view_middle 부터 board_btn_wrap 앞까지, 스크립트는 파서가 버린다', () => {
    const html = piuNoticeContentHtml(PAGE);
    expect(html).not.toBeNull();
    expect(html).toContain('첫 문단');
    expect(html).not.toContain('본문 밖');
    expect(html).not.toContain('목록');
    const doc = docOf(html!);
    expect(docToText(doc)).toBe('첫 문단');
  });

  it('본문 칸이 없으면 null — 부르는 쪽이 링크만 싣는다', () => {
    expect(piuNoticeContentHtml('<div class="other">x</div>')).toBeNull();
    expect(piuNoticeContentHtml('<div class="board_view_middle">끝 표시가 없음')).toBeNull();
  });
});

describe('htmlToBlocks — 편집기 마크업을 우리 문서로', () => {
  it('문단 · 굵게 · 기울임 · 줄바꿈, 빈 문단(&nbsp;)은 건너뛴다', () => {
    const doc = docOf(
      '<p>안녕하세요.</p><p>&nbsp;</p><p> </p>' +
        '<p>휴무는 <strong>9월 24일부터</strong> 입니다.<br />(<em>한국 시간</em>)</p>',
    );
    expect(doc.content).toHaveLength(2);
    expect(doc.content[1]).toEqual({
      type: 'paragraph',
      content: [
        { type: 'text', text: '휴무는 ' },
        { type: 'text', text: '9월 24일부터', marks: [{ type: 'bold' }] },
        { type: 'text', text: ' 입니다.' },
        { type: 'hardBreak' },
        { type: 'text', text: '(' },
        { type: 'text', text: '한국 시간', marks: [{ type: 'italic' }] },
        { type: 'text', text: ')' },
      ],
    });
    expectAppCompatible(doc);
  });

  it('줄바꿈 앞뒤의 들여쓰기 공백을 걷어 낸다', () => {
    const doc = docOf('<p>1) 타이틀 : 곡<br />&nbsp; 아티스트 : 누구&nbsp;<br />&nbsp; BPM : 128</p>');
    expect(docToText(doc)).toBe('1) 타이틀 : 곡\n아티스트 : 누구\nBPM : 128');
    expectAppCompatible(doc);
  });

  it('그림은 복사하지 않고 원문 그림 링크 한 줄로 — 크게 보기 링크가 있으면 그 주소를', () => {
    const doc = docOf(
      '<p><a href="/bbs/view_image.php?fn=big.png" class="view_image"><img src="/data/thumb.png" alt=""/></a></p>' +
        '<p><img src="https://piugame.com/data/poster.png" alt="포스터" /></p>',
    );
    expect(doc.content).toEqual([
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: '그림 보기 (piugame.com)',
            marks: [{ type: 'link', attrs: { href: 'https://piugame.com/bbs/view_image.php?fn=big.png' } }],
          },
        ],
      },
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: '그림 보기 — 포스터',
            marks: [{ type: 'link', attrs: { href: 'https://piugame.com/data/poster.png' } }],
          },
        ],
      },
    ]);
    expect(JSON.stringify(doc)).not.toContain('postImage');
    expectAppCompatible(doc);
  });

  it('제목은 한 단씩 내린다 (h1 → 2, 그 아래 → 3) — 페이지 제목이 이미 가장 크다', () => {
    const doc = docOf('<h1><strong>1. 결과</strong></h1><h2><span style="background-color:red">&lt;마스터부&gt;</span></h2><h3>세부</h3>');
    expect(doc.content.map((b) => [b.type, b.attrs?.level])).toEqual([
      ['heading', 2],
      ['heading', 3],
      ['heading', 3],
    ]);
    expect(docToText(doc)).toBe('1. 결과\n<마스터부>\n세부');
    expectAppCompatible(doc);
  });

  it('표는 표로 — 겉모양(너비 · 색)은 버리고, 빈 칸에도 빈 문단을 둔다', () => {
    const doc = docOf(
      '<table style="width:48%" border="1"><colgroup><col style="width:7%" /></colgroup><tbody>' +
        '<tr><th><strong>랭킹</strong></th><th>닉네임</th></tr>' +
        '<tr><td style="height:22px">1</td><td></td></tr>' +
        '</tbody></table>',
    );
    expect(doc.content).toHaveLength(1);
    const table = doc.content[0];
    expect(table.type).toBe('table');
    expect(table.content?.map((row) => row.content?.map((c) => c.type))).toEqual([
      ['tableHeader', 'tableHeader'],
      ['tableCell', 'tableCell'],
    ]);
    expect(JSON.stringify(doc)).not.toContain('48%');
    // 끝의 빈 칸(탭)은 앱의 toPlainText 처럼 마지막 trim 에서 사라진다
    expect(docToText(doc)).toBe('랭킹\t닉네임\n1');
    expectAppCompatible(doc);
  });

  it('목록 · 인용 · 가로줄', () => {
    const doc = docOf('<ul><li>하나</li><li><p>둘</p></li></ul><ol><li>첫째</li></ol><blockquote><p>인용</p></blockquote><hr />');
    expect(doc.content.map((b) => b.type)).toEqual(['bulletList', 'orderedList', 'blockquote', 'horizontalRule']);
    expect(docToText(doc)).toBe('· 하나\n· 둘\n1. 첫째\n> 인용');
    expectAppCompatible(doc);
  });

  it('링크는 절대 주소로, http(s) 가 아닌 링크는 글자만 남긴다', () => {
    const doc = docOf('<p><a href="/bbs/board.php?wr_id=2">다음 공지</a> · <a href="javascript:alert(1)">위험</a></p>');
    expect(doc.content[0].content).toEqual([
      {
        type: 'text',
        text: '다음 공지',
        marks: [{ type: 'link', attrs: { href: 'https://piugame.com/bbs/board.php?wr_id=2' } }],
      },
      { type: 'text', text: ' · 위험' },
    ]);
    expectAppCompatible(doc);
  });

  it('유튜브 iframe 은 우리 유튜브 블록으로, 다른 iframe 은 버린다', () => {
    const doc = docOf(
      '<p>영상</p><iframe src="https://www.youtube.com/embed/abcdefghijk" width="560"></iframe>' +
        '<iframe src="https://evil.example/embed"></iframe>',
    );
    expect(doc.content.map((b) => b.type)).toEqual(['paragraph', 'youtube']);
    expect(doc.content[1].attrs).toEqual({ videoId: 'abcdefghijk' });
    expectAppCompatible(doc);
  });

  it('모르는 태그(div · font · span)는 껍데기만 벗기고 글자는 살린다', () => {
    const doc = docOf('<div><font color="red"><span style="font-size:30px">빨간 큰 글자</span></font></div><div>둘째 &amp; 셋째 &#39;따옴표&#39;</div>');
    expect(docToText(doc)).toBe("빨간 큰 글자\n둘째 & 셋째 '따옴표'");
    expect(JSON.stringify(doc)).not.toContain('textStyle');
    expectAppCompatible(doc);
  });

  it('너무 길면 예산에서 멈추고 truncated 를 켠다 — 앱이 몰래 자르지 않게', () => {
    const html = Array.from({ length: 3000 }, (_, i) => `<p>문단 ${i}</p>`).join('');
    const { blocks, truncated } = htmlToBlocks(html, BASE);
    expect(truncated).toBe(true);
    const doc = { type: 'doc', content: blocks } as RichDoc;
    // 앱의 한도(MAX_NODES 2000) 안이라 normalizeDoc 이 아무것도 떼지 않는다
    expectAppCompatible(doc);
  });

  it('글자 참조를 푼다', () => {
    expect(decodeEntities('&lt;a&gt; &amp; &quot;b&quot; &#8230; &#x2014; &nbsp;끝')).toBe('<a> & "b" … —  끝');
  });
});

describe('동기화가 만드는 글 모양 전체도 앱과 맞는다', () => {
  it('본문 · 가로줄 · 기울인 출처 안내 · 원문 링크', () => {
    const { blocks } = htmlToBlocks('<p>본문</p>', BASE);
    // scripts/sync-news.mjs bodyDoc 과 같은 모양
    const doc = {
      type: 'doc',
      content: [
        ...blocks,
        { type: 'horizontalRule' },
        { type: 'paragraph', content: [{ type: 'text', text: '공식 공지를 옮겨 왔어요.', marks: [{ type: 'italic' }] }] },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: '원문 보기 — piugame.com', marks: [{ type: 'link', attrs: { href: BASE } }] }],
        },
      ],
    } as RichDoc;
    expectAppCompatible(doc);
    expect(docToText(doc)).toBe('본문\n\n공식 공지를 옮겨 왔어요.\n원문 보기 — piugame.com');
  });
});
