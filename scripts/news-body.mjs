/**
 * 공식 공지의 **본문 HTML → 우리 글 문서(body_doc)** 변환기 (scripts/sync-news.mjs 가 씁니다).
 *
 * ─── 왜 따로 있나 ────────────────────────────────────────────
 * sync-news.mjs 는 모듈 최상위에서 DB 에 붙고 process.exit 하는 "혼자 도는 프로그램" 이라
 * 테스트가 import 할 수 없습니다. 변환은 순수 함수라 여기 떼어 두고 tests/news-body.test.ts
 * 가 **앱의 normalizeDoc 에 통과시켜** 봅니다 — 여기서 만든 문서가 앱이 그리는 문서와
 * 한 글자도 다르지 않아야 합니다.
 *
 * lib/rich-text.ts 를 직접 부르지 않는 이유: 그 파일의 import 에 확장자가 없어 Node 가
 * 번들러 없이 풀지 못합니다(lib/prisma.ts 머리말과 같은 사정). 그래서 허용되는 모양만
 * 만들도록 여기서 좁게 쓰고, 어긋나면 테스트가 잡습니다.
 *
 * ─── 무엇을 옮기고 무엇을 버리나 ─────────────────────────────
 *   옮김  문단 · 줄바꿈 · 제목(h1→2, h2 이하→3) · 목록 · 인용 · 가로줄 · 표 ·
 *         굵게 · 기울임 · 밑줄 · 취소선 · 링크(http/https) · 유튜브 iframe
 *   버림  글자색 · 배경색 · 글꼴 · 표 너비 같은 **겉모양** — 우리 글의 색 집합과 맞지 않고,
 *         남의 사이트 색을 그대로 가져오면 다크 테마에서 글자가 사라집니다.
 *   바꿈  **그림은 복사하지 않습니다.** 원문 그림으로 가는 링크 한 줄로 바꿉니다 —
 *         남의 이미지를 우리 서버에 옮겨 싣지 않고, 우리 글 형식도 외부 그림을 받지
 *         않습니다(첨부 id 만 받음, lib/rich-text.ts postImage).
 *
 * HTML 파서를 들이지 않았습니다 (sync-news.mjs 머리말과 같은 판단). 공지 본문은 편집기가
 * 만든 평범한 마크업이라 태그 토큰 단위로 나무를 세우는 것으로 충분하고, 모르는 태그는
 * 껍데기만 벗기고 안의 글자는 살립니다.
 */

/** 앱의 MAX_NODES(2000)보다 넉넉히 아래 — 머리말·원문 링크 줄이 뒤에 붙습니다 */
const NODE_BUDGET = 1800;
/** 평문 상한. 앱의 글 본문 상한(lib/validation.ts MAX_BODY 20,000)보다 아래 */
const TEXT_BUDGET = 18_000;

const VOID = new Set(['br', 'img', 'hr', 'col', 'input', 'meta', 'link', 'source', 'wbr']);
/** 안의 내용까지 통째로 버리는 태그 (script · style 은 parseHtml 이 토큰화 전에 지웁니다) */
const DROP = new Set(['colgroup', 'button', 'form', 'select', 'textarea']);
/** 블록으로 다루는 태그 — 이 안의 글자는 한 문단(또는 그 이상)이 됩니다 */
const BLOCK = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'center',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'blockquote', 'hr', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'figure', 'figcaption', 'pre', 'iframe',
]);

// ─── 글자 ────────────────────────────────────────────────────

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', hellip: '…', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”' };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    }
    return NAMED[body.toLowerCase()] ?? whole;
  });
}

// ─── HTML → 나무 ─────────────────────────────────────────────

function parseAttrs(src) {
  const attrs = {};
  for (const m of src.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    attrs[m[1].toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? '');
  }
  return attrs;
}

/** 태그 토큰으로 나무를 세웁니다. 닫히지 않은 태그는 부모가 닫힐 때 같이 닫힙니다 */
export function parseHtml(input) {
  // 스크립트 안의 `a<b` 가 태그처럼 읽혀 닫는 태그를 삼키지 않게, 토큰화 **전에** 통째로 지웁니다.
  const html = input.replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, '');
  const root = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\/?([a-zA-Z][a-zA-Z0-9]*)([^>]*)>|([^<]+)|</g;
  let m;
  let dropping = null;
  while ((m = re.exec(html)) !== null) {
    const [token, rawTag, rest, text] = m;
    const top = stack[stack.length - 1];
    if (token.startsWith('<!--')) continue;

    if (dropping) {
      if (rawTag && token.startsWith('</') && rawTag.toLowerCase() === dropping) dropping = null;
      continue;
    }
    if (text !== undefined || token === '<') {
      top.children.push({ text: text ?? '<' });
      continue;
    }

    const tag = rawTag.toLowerCase();
    if (token.startsWith('</')) {
      // 가장 가까운 같은 이름까지 닫습니다. 없으면 무시합니다(짝 없는 닫는 태그).
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    if (DROP.has(tag)) {
      if (!/\/\s*$/.test(rest)) dropping = tag;
      continue;
    }
    const node = { tag, attrs: parseAttrs(rest), children: [] };
    top.children.push(node);
    if (!VOID.has(tag) && !/\/\s*$/.test(rest)) stack.push(node);
  }
  return root;
}

// ─── 나무 → 문서 ─────────────────────────────────────────────

function absUrl(raw, base) {
  if (!raw) return null;
  try {
    const url = new URL(raw.trim(), base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const href = url.toString();
    return href.length <= 2000 ? href : null;
  } catch {
    return null;
  }
}

const YOUTUBE_PATTERNS = [
  /youtube(?:-nocookie)?\.com\/(?:embed|shorts|live)\/([A-Za-z0-9_-]{11})/,
  /youtube\.com\/watch\?(?:.*&)?v=([A-Za-z0-9_-]{11})/,
  /youtu\.be\/([A-Za-z0-9_-]{11})/,
];
function youtubeIdOf(src) {
  for (const re of YOUTUBE_PATTERNS) {
    const m = re.exec(src ?? '');
    if (m) return m[1];
  }
  return null;
}

const MARK_OF = { strong: 'bold', b: 'bold', em: 'italic', i: 'italic', u: 'underline', s: 'strike', strike: 'strike', del: 'strike', code: 'code' };
/** 앱의 normalizeMarks 와 같은 순서 규칙 — 같은 종류는 한 번, 들어온 순서대로 */
function addMark(marks, mark) {
  if (marks.some((m) => m.type === mark.type)) return marks;
  return [...marks, mark];
}

/**
 * 변환 상태. 예산을 다 쓰면 그 자리에서 멈추고 `truncated` 를 켭니다 — 앱의 normalizeDoc 이
 * 뒤를 몰래 자르는 것보다, 여기서 멈추고 "나머지는 원문에서" 를 붙이는 쪽이 정직합니다.
 */
function makeState(base) {
  return { base, nodes: NODE_BUDGET, chars: TEXT_BUDGET, truncated: false };
}

function spend(state, nodes, chars = 0) {
  if (state.nodes - nodes < 0 || state.chars - chars < 0) {
    state.truncated = true;
    return false;
  }
  state.nodes -= nodes;
  state.chars -= chars;
  return true;
}

/**
 * 인라인 나열 → text · hardBreak 노드. 공백은 HTML 처럼 접습니다.
 * 그림은 인라인 자리에서 만나면 `images` 로 빼 두었다가 문단 뒤에 링크 줄로 붙입니다.
 */
function inlineOf(nodes, state, marks, images) {
  const out = [];
  const push = (text, withMarks) => {
    if (!text) return;
    const last = out[out.length - 1];
    const same = last && last.type === 'text' && JSON.stringify(last.marks ?? []) === JSON.stringify(withMarks);
    if (same) {
      last.text += text;
      state.chars -= text.length;
      return;
    }
    if (!spend(state, 1, text.length)) return;
    out.push(withMarks.length ? { type: 'text', text, marks: withMarks } : { type: 'text', text });
  };

  const walk = (list, active) => {
    for (const n of list) {
      if (state.truncated) return;
      if ('text' in n) {
        push(decodeEntities(n.text).replace(/[\s ]+/g, ' '), active);
        continue;
      }
      if (n.tag === 'br') {
        if (spend(state, 1)) out.push({ type: 'hardBreak' });
        continue;
      }
      if (n.tag === 'img') {
        images.push(n);
        continue;
      }
      let next = active;
      if (MARK_OF[n.tag]) next = addMark(active, { type: MARK_OF[n.tag] });
      if (n.tag === 'a') {
        // 그림만 감싼 링크(원문 그림 크게 보기)는 링크 표시 대신 그림 링크 줄의 주소로 씁니다.
        const onlyImage = n.children.every((c) => ('text' in c ? c.text.trim() === '' : c.tag === 'img'));
        if (onlyImage) {
          for (const c of n.children) if (!('text' in c)) images.push({ ...c, viewer: n.attrs.href });
          continue;
        }
        const href = absUrl(n.attrs.href, state.base);
        if (href) next = addMark(next, { type: 'link', attrs: { href } });
      }
      walk(n.children, next);
    }
  };
  walk(nodes, marks);

  // 문단 앞뒤의 공백·줄바꿈을 정리합니다 — 편집기가 남긴 빈 줄이 글에서 빈 칸으로 보이지 않게.
  while (out.length && out[0].type === 'hardBreak') out.shift();
  while (out.length && out[out.length - 1].type === 'hardBreak') out.pop();
  // 줄의 앞뒤 공백 — 문단 처음과 끝, 줄바꿈 바로 앞뒤. 원문이 들여쓰기로 넣은 공백(&nbsp;)도 여기서 정리됩니다.
  out.forEach((n, i) => {
    if (n.type !== 'text') return;
    if (i === 0 || out[i - 1].type === 'hardBreak') n.text = n.text.replace(/^ +/, '');
    if (i === out.length - 1 || out[i + 1].type === 'hardBreak') n.text = n.text.replace(/ +$/, '');
  });
  return out.filter((n) => n.type !== 'text' || n.text !== '');
}

function imageLinks(images, state) {
  const out = [];
  for (const img of images) {
    const href = absUrl(img.viewer, state.base) ?? absUrl(img.attrs?.src, state.base);
    if (!href) continue;
    if (!spend(state, 2, 12)) break;
    const alt = (img.attrs?.alt ?? '').trim();
    out.push({
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: alt ? `그림 보기 — ${alt}` : `그림 보기 (${new URL(href).host})`,
          marks: [{ type: 'link', attrs: { href } }],
        },
      ],
    });
  }
  return out;
}

const hasBlockChild = (n) => n.children.some((c) => !('text' in c) && BLOCK.has(c.tag));

/** 블록 나열 → 문서 블록. 블록 안에 인라인이 섞이면 인라인 덩어리를 문단으로 묶습니다 */
function blocksOf(nodes, state) {
  const out = [];
  let run = [];

  const flushRun = () => {
    if (run.length === 0) return;
    const images = [];
    const content = inlineOf(run, state, [], images);
    run = [];
    if (content.length && spend(state, 1)) out.push({ type: 'paragraph', content });
    out.push(...imageLinks(images, state));
  };

  for (const n of nodes) {
    if (state.truncated) break;
    if ('text' in n || !BLOCK.has(n.tag)) {
      run.push(n);
      continue;
    }
    flushRun();
    out.push(...blockOf(n, state));
  }
  flushRun();
  return out;
}

function blockOf(n, state) {
  switch (n.tag) {
    case 'p':
    case 'figcaption':
    case 'pre': {
      if (hasBlockChild(n)) return blocksOf(n.children, state);
      const images = [];
      const content = inlineOf(n.children, state, [], images);
      const out = [];
      if (content.length && spend(state, 1)) out.push({ type: 'paragraph', content });
      out.push(...imageLinks(images, state));
      return out;
    }
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
      const images = [];
      const content = inlineOf(n.children, state, [], images);
      const out = [];
      // 글 제목이 이미 페이지의 큰 제목이라 한 단씩 내립니다 (h1 → 2, 그 아래 → 3).
      const level = n.tag === 'h1' ? 2 : 3;
      if (content.length && spend(state, 1)) out.push({ type: 'heading', attrs: { level }, content });
      out.push(...imageLinks(images, state));
      return out;
    }
    case 'hr':
      return spend(state, 1) ? [{ type: 'horizontalRule' }] : [];
    case 'blockquote': {
      const content = blocksOf(n.children, state);
      return content.length && spend(state, 1) ? [{ type: 'blockquote', content }] : [];
    }
    case 'ul':
    case 'ol': {
      const items = [];
      for (const li of n.children) {
        if ('text' in li || li.tag !== 'li' || state.truncated) continue;
        const content = blocksOf(li.children, state);
        if (content.length && spend(state, 1)) items.push({ type: 'listItem', content });
      }
      return items.length && spend(state, 1)
        ? [{ type: n.tag === 'ul' ? 'bulletList' : 'orderedList', content: items }]
        : [];
    }
    case 'table':
      return tableOf(n, state);
    case 'iframe': {
      const videoId = youtubeIdOf(n.attrs.src);
      return videoId && spend(state, 1) ? [{ type: 'youtube', attrs: { videoId } }] : [];
    }
    default:
      // div · li · td 같은 껍데기는 벗기고 안을 봅니다.
      return blocksOf(n.children, state);
  }
}

function tableOf(table, state) {
  const rows = [];
  const collect = (list) => {
    for (const n of list) {
      if ('text' in n) continue;
      if (n.tag === 'tr') rows.push(n);
      else if (n.tag === 'thead' || n.tag === 'tbody' || n.tag === 'tfoot') collect(n.children);
    }
  };
  collect(table.children);

  const outRows = [];
  for (const tr of rows) {
    if (state.truncated) break;
    const cells = [];
    for (const td of tr.children) {
      if ('text' in td || (td.tag !== 'td' && td.tag !== 'th')) continue;
      let content = blocksOf(td.children, state);
      // 앱의 표 칸은 문단이 하나 이상 있어야 편집기가 칸을 그립니다 — 빈 칸에도 빈 문단을 둡니다.
      if (content.length === 0) content = [{ type: 'paragraph', content: [] }];
      if (!spend(state, 1)) break;
      cells.push({ type: td.tag === 'th' ? 'tableHeader' : 'tableCell', content });
    }
    if (cells.length && spend(state, 1)) outRows.push({ type: 'tableRow', content: cells });
  }
  return outRows.length && spend(state, 1) ? [{ type: 'table', content: outRows }] : [];
}

/**
 * 본문 HTML → `{ blocks, truncated }`. 블록이 하나도 없으면 빈 배열입니다.
 * @param {string} html 본문 영역의 HTML (piuNoticeContentHtml 의 결과)
 * @param {string} baseUrl 상대 주소를 풀 기준 (원문 글 주소)
 */
export function htmlToBlocks(html, baseUrl) {
  const state = makeState(baseUrl);
  const blocks = blocksOf(parseHtml(html).children, state);
  return { blocks, truncated: state.truncated };
}

// ─── 문서 → 평문 (posts.body) ─────────────────────────────────

/**
 * lib/rich-text.ts toPlainText 와 **같은 규칙**입니다 (첨부 마커만 없음).
 * posts.body 가 검색·미리보기의 근거라 둘이 어긋나면 안 됩니다 — tests/news-body.test.ts 가
 * 같은 문서를 두 함수에 넣어 대조합니다.
 */
export function docToText(doc) {
  const lines = [];
  const inline = (nodes) => (nodes ?? []).map((n) => (n.type === 'hardBreak' ? '\n' : (n.text ?? ''))).join('');
  const block = (nodes, indent) => {
    for (const n of nodes) {
      switch (n.type) {
        case 'paragraph':
        case 'heading':
          lines.push(indent + inline(n.content));
          break;
        case 'horizontalRule':
          lines.push('');
          break;
        case 'blockquote':
          block(n.content ?? [], `${indent}> `);
          break;
        case 'bulletList':
        case 'orderedList':
          (n.content ?? []).forEach((item, i) => {
            const bullet = n.type === 'bulletList' ? '· ' : `${i + 1}. `;
            const before = lines.length;
            block(item.content ?? [], indent);
            if (lines.length > before) lines[before] = indent + bullet + lines[before].slice(indent.length);
          });
          break;
        case 'table':
          for (const row of n.content ?? []) {
            const cells = (row.content ?? []).map((cell) => {
              const at = lines.length;
              block(cell.content ?? [], '');
              return lines.splice(at).filter((l) => l !== '').join(' ');
            });
            lines.push(indent + cells.join('\t'));
          }
          break;
        case 'youtube':
          lines.push(`https://youtu.be/${String(n.attrs?.videoId)}`);
          break;
      }
    }
  };
  block(doc.content, '');
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ─── 펌프 잇 업 (piugame.com) 공지 본문 ──────────────────────

/**
 * 공지 상세 페이지에서 **본문 영역만** 떼어 냅니다.
 *
 * piugame 은 그누보드 스킨이라 본문이 `board_view_middle` 칸 안에 있고, 그 칸의 앞쪽에는
 * 스킨 스크립트가 들어 있습니다(파서가 스크립트를 통째로 버립니다). 칸의 끝은 바로 뒤에
 * 오는 `board_btn_wrap`(목록 단추 줄)으로 잡습니다 — 닫는 `</div>` 를 세지 않아도 됩니다.
 *
 * 못 찾으면 null — 구조가 바뀐 것이라 부르는 쪽이 "본문 없이 링크만" 으로 물러납니다.
 */
export function piuNoticeContentHtml(pageHtml) {
  const open = /<div[^>]*class="[^"]*\bboard_view_middle\b[^"]*"[^>]*>/.exec(pageHtml);
  if (!open) return null;
  const start = open.index + open[0].length;
  const end = pageHtml.indexOf('board_btn_wrap', start);
  if (end < 0) return null;
  // board_btn_wrap 이 든 여는 태그의 '<' 까지 — 그 앞의 </div> 는 파서가 알아서 삼킵니다.
  const cut = pageHtml.lastIndexOf('<', end);
  return pageHtml.slice(start, cut > start ? cut : end);
}
