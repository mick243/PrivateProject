import type {
  Board,
  BoardCategory,
  PostComment,
  PostAttachment,
  PostDetail,
  PostSort,
  PostSummary,
} from './board-types';
import { attachmentIdsInBody, stripMarkers } from './board-content';
import {
  attachmentUrl,
  COMMENTS_PAGE_SIZE,
  NOTICE_CATEGORY,
  NOTICE_PIN_LIMIT,
  POPULAR_MIN_LIKES,
  POSTS_PAGE_SIZE,
} from './board-types';
import { cacheReference, clearReferenceCache } from './cache';
import { getDb, type Queryable } from './db';
import { normalizeDoc, type RichDoc } from './rich-text';

/**
 * 커뮤니티 게시판.
 *
 * 게임별 탭은 테이블이 아니라 `posts.machine_id` 필터입니다 — '전체' 탭은 필터를
 * 걸지 않은 조회일 뿐이고, 게임을 추가할 때 마이그레이션이 필요 없습니다.
 */

function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

function num(v: unknown): number {
  return Number(v);
}

/**
 * jsonb 컬럼 → 문서.
 *
 * 드라이버에 따라 이미 객체로 파싱돼 오기도 하고(node-postgres) 문자열로 오기도
 * 해서 둘을 다 받습니다. 그리고 **읽을 때도 정규화를 통과시킵니다** — 지금 코드가
 * 넣은 값만 들어 있을 테지만, 스키마가 좁아지는 변경(색 하나를 빼는 것 같은) 뒤에
 * 옛 문서가 그대로 화면까지 흘러가지 않게 하는 그물입니다.
 */
function docFromDb(v: unknown): RichDoc | null {
  return v === null || v === undefined ? null : normalizeDoc(v);
}

/** 목록 본문 미리보기 길이. 전문을 목록에 실으면 20건 응답이 수십 KB가 된다. */
const EXCERPT_LENGTH = 120;

function excerptOf(body: string): string {
  // 이미지 마커는 걷어낸다 — 목록에 '[[image:12]]' 가 보이면 안 된다.
  const flat = stripMarkers(body).replace(/\s+/g, ' ').trim();
  return flat.length > EXCERPT_LENGTH ? `${flat.slice(0, EXCERPT_LENGTH)}…` : flat;
}

// ─── 탭 / 말머리 ─────────────────────────────────────────────

/**
 * 게임 탭 목록.
 *
 * 리듬 기종 전부를 돌려줍니다 — 글이 0건인 게임도 탭에 남깁니다. 글이 있는 게임만
 * 보여주면 새 게임에 첫 글을 쓸 방법이 없어집니다 (닭과 달걀).
 * 리듬게임이 아닌 기종(category='etc')은 제외합니다.
 */
export async function listBoards(): Promise<Board[]> {
  const db = await getDb();
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT m.id, m.name, m.short_name,
            (SELECT COUNT(*)::int FROM posts p WHERE p.machine_id = m.id) AS post_count
     FROM machines m
     WHERE m.category = 'rhythm'
     ORDER BY m.sort_order, m.id`,
  );
  return rows.map((r) => ({
    machineId: num(r.id),
    name: r.name as string,
    shortName: r.short_name as string,
    postCount: num(r.post_count),
  }));
}

export async function listCategories(): Promise<BoardCategory[]> {
  const db = await getDb();
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT code, label FROM board_categories ORDER BY sort_order`,
  );
  return rows.map((r) => ({ code: r.code as string, label: r.label as string }));
}

// ─── 글 목록 ─────────────────────────────────────────────────

const POST_SELECT = `
  SELECT p.id, p.machine_id, p.category, p.player_id, p.title, p.body, p.body_doc,
         p.comment_count, p.like_count, p.view_count, p.created_at, p.updated_at,
         m.name        AS machine_name,
         m.short_name  AS machine_short_name,
         bc.label      AS category_label,
         pl.nickname   AS nickname,
         (myl.player_id IS NOT NULL) AS my_like,
         thumb.id      AS thumb_id,
         thumb.mime    AS thumb_mime
  FROM posts p
  -- LEFT JOIN — 게임 없는 글(공지)이 목록에서 사라지지 않아야 한다. INNER JOIN 이면
  -- machine_id 가 NULL 인 행은 조용히 빠진다.
  LEFT JOIN machines m     ON m.id  = p.machine_id
  JOIN board_categories bc ON bc.code = p.category
  JOIN players pl          ON pl.id = p.player_id
  LEFT JOIN post_likes myl ON myl.post_id = p.id AND myl.player_id = $1::int
  -- 목록 썸네일 = 이 글의 첫 첨부 한 건.
  --
  -- post_images_post_idx (post_id, sort_order, id) 를 그대로 타는 LIMIT 1 이라
  -- 행당 인덱스 탐색 한 번이고, 첨부가 1개든 5개든 비용이 같습니다. 아래 listPosts 의
  -- '목록은 LIMIT 이 인덱스까지 내려간다' 는 성질도 그대로입니다 — 중첩 루프의 안쪽이라
  -- 실제로 뽑히는 20여 행에 대해서만 돕니다.
  --
  -- 사진/영상을 가리지 않습니다 (board-types.ts PostThumbnail 참고). mime 을 조건에
  -- 넣으면 인덱스가 아니라 글마다 첨부 전부를 훑는 필터가 됩니다.
  LEFT JOIN LATERAL (
    SELECT pi.id, pi.mime
      FROM post_images pi
     WHERE pi.post_id = p.id
     ORDER BY pi.sort_order, pi.id
     LIMIT 1
  ) thumb ON true`;

function toSummary(r: Record<string, unknown>): PostSummary {
  return {
    id: num(r.id),
    machineId: r.machine_id === null ? null : num(r.machine_id),
    machineShortName: (r.machine_short_name as string | null) ?? null,
    category: r.category as string,
    categoryLabel: r.category_label as string,
    playerId: num(r.player_id),
    nickname: r.nickname as string,
    title: r.title as string,
    excerpt: excerptOf(r.body as string),
    // 첨부가 없으면 LATERAL 이 NULL 을 내므로 그대로 '썸네일 없음' 이 된다.
    thumbnail:
      r.thumb_id === null || r.thumb_id === undefined
        ? null
        : {
            id: num(r.thumb_id),
            url: attachmentUrl(num(r.thumb_id)),
            mime: r.thumb_mime as string,
          },
    commentCount: num(r.comment_count),
    likeCount: num(r.like_count),
    viewCount: num(r.view_count),
    myLike: Boolean(r.my_like),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

export interface ListPostsParams {
  /** null = '전체' 탭 (모든 게임) */
  machineId?: number | null;
  category?: string | null;
  sort?: PostSort;
  playerId?: number | null;
  /**
   * 제목·본문 부분 일치. 게시판 검색창과, 챗봇이 "커뮤니티에서 뭐라고들 하나" 를
   * 뒤질 때(lib/chat-tools.ts) 같은 경로를 씁니다.
   * 본문까지 보는 이유: 제목만으로는 "발판" 이야기가 어느 글에 있는지 못 찾습니다.
   */
  q?: string | null;
  limit?: number;
  offset?: number;
}

export interface ListPostsResult {
  posts: PostSummary[];
  /**
   * 목록 맨 위에 고정되는 공지. `posts` 와 겹치지 않고, `total` 에도 들어가지
   * 않습니다 — 페이지 수는 일반 글만으로 계산되고 공지는 모든 페이지에 붙습니다.
   *
   * 게임 탭·말머리·정렬과 무관하게 같은 목록입니다 (아래 listPosts 주석 참고).
   * '공지' 말머리를 직접 고른 조회와 검색(q)에서는 비어 있습니다 — 검색 결과
   * 맨 위에 찾는 말과 무관한 공지가 붙으면 "몇 건 찾았나" 를 읽을 수 없습니다.
   */
  notices: PostSummary[];
  total: number;
  /** offset + limit < total */
  hasMore: boolean;
}

export async function listPosts(params: ListPostsParams): Promise<ListPostsResult> {
  const db = await getDb();
  const {
    machineId = null,
    category = null,
    sort = 'recent',
    playerId = null,
    q = null,
    limit = POSTS_PAGE_SIZE,
    offset = 0,
  } = params;

  const term = q && q.trim() ? q.trim() : null;

  // 인기글은 정렬이 아니라 '기준선을 넘은 글만' 이다. 최신순에는 걸지 않으므로
  // NULL 을 넣어 조건을 통과시킨다 (아래 두 쿼리의 IS NULL 분기).
  const minLikes = sort === 'popular' ? POPULAR_MIN_LIKES : null;

  /**
   * 공지를 위에 따로 붙일 조회인가.
   *
   * 공지는 '어느 게임 게시판에 썼는지' 와 무관하게 모든 탭 맨 위에 서야 하므로
   * 필터를 타는 목록에 섞을 수 없다 — 다른 게임 탭이나 다른 말머리를 고르면
   * 조건에서 빠져 사라진다. 그래서 별도 쿼리로 뽑아 올리고, 본 목록에서는
   * 빼서 같은 글이 두 번 나오지 않게 한다.
   *
   * 두 경우는 예외로 섞어 둔다:
   *   · '공지' 말머리를 직접 고른 조회 — 그 목록 자체가 공지다 (고정+본문 중복).
   *   · 검색(q) — 화면의 검색창과 챗봇이 같이 쓰는 경로다. 찾는 말과 무관한
   *     공지가 결과 앞에 끼면 검색 결과가 아닌 것이 검색 결과처럼 보인다.
   */
  const pinNotices = category !== NOTICE_CATEGORY && term === null;
  // NULL 이면 제외하지 않는다 (아래 두 쿼리의 `p.category <> ...` 분기).
  const excluded = pinNotices ? NOTICE_CATEGORY : null;

  /**
   * '공지' 말머리를 고르면 게임 탭을 무시한다.
   *
   * 공지는 어느 게시판에 썼든 모든 탭 맨 위에 고정되므로, 사볼 탭에서 방금
   * 위에 붙어 있던 공지가 '공지' 를 누른 순간 "아직 글이 없습니다" 로 바뀌면
   * 같은 화면이 스스로를 부정하는 셈이 된다. 고정과 필터가 같은 목록을 봐야 한다.
   */
  const tab = category === NOTICE_CATEGORY ? null : machineId;

  /**
   * 정렬 키. SQL 의 ORDER BY 와 아래 JS 재정렬이 **같은 표**를 읽습니다 — 두 곳에
   * 따로 적으면 한쪽만 고쳐져 목록이 조용히 뒤섞입니다. 전부 내림차순이고,
   * 문자열 보간 지점이므로 컬럼명은 이 화이트리스트에서만 옵니다.
   */
  const SORT_KEYS: Record<PostSort, string[]> = {
    recent: ['created_at', 'id'],
    popular: ['like_count', 'comment_count', 'created_at'],
  };
  const NOTICE_KEYS = SORT_KEYS.recent; // 공지는 정렬 옵션과 무관하게 항상 최신순
  const orderBy = (keys: string[]) => keys.map((k) => `p.${k} DESC`).join(', ');

  /**
   * 목록과 총계를 **따로** 가져옵니다.
   *
   * 한때 `COUNT(*) OVER ()` 로 한 쿼리에 합쳤었습니다. 30행에서는 멀쩡했지만
   * 5만 행을 넣고 재 보니 141ms 로, 따로 세던 예전(5.9ms)보다 24배 느렸습니다.
   * 이유는 둘입니다.
   *
   *   · 창 함수가 LIMIT 을 아래로 못 밀어넣습니다. 20건만 필요한데도 조건에 맞는
   *     행을 **전부** 정렬해야 해서, 목록 쿼리가 Index Scan(21행에서 멈춤)에서
   *     Seq Scan + 전체 정렬로 내려앉습니다.
   *   · 그 전부가 machines·board_categories·players·post_likes 4개 조인을 통과합니다.
   *     조인 없이 posts 만 훑던 COUNT 는 Index Only Scan 이라 훨씬 쌉니다.
   *
   * 그래서 목록은 LIMIT 이 인덱스까지 내려가도록 되돌리고(0.2ms), 총계는 아래
   * countPosts 에서 캐시로 받습니다. 풀 슬롯을 아끼려던 원래 의도는 캐시가
   * 대신합니다 — 대부분의 요청은 총계 때문에 DB 를 치지 않습니다.
   *
   * **고정 공지는 목록과 한 왕복으로 가져옵니다** (UNION ALL, 2026-09-08).
   *
   * 공지는 필터를 안 타는 별도 목록이라 예전에는 쿼리를 따로 보냈습니다. 그런데
   * 200 VU 측정에서 병목이 SQL 이 아니라 **풀 슬롯을 잡고 있는 시간**으로 확인됐습니다
   * (PERFORMANCE.md) — 쿼리 하나가 실제로 실행되는 3ms 가 아니라, 슬롯을 잡은 채 노드
   * 이벤트 루프 차례를 기다리는 20~50ms 만큼 슬롯을 점유합니다. 그래서 왕복 수가 곧
   * 비용입니다. 공지 갈래는 `$9::boolean` 이 false 면 행을 내지 않으므로, 예전에
   * 쿼리를 아예 보내지 않던 경우(pinNotices=false)와 결과가 같습니다.
   *
   * 총계까지 한 쿼리에 넣지 않는 이유는 바로 위 주석입니다 — 그쪽은 캐시가 맞습니다.
   */
  const [{ rows }, total] = await Promise.all([
    db.query<Record<string, unknown>>(
      `SELECT page.*, false AS is_notice
         FROM (${POST_SELECT}
               WHERE ($2::int  IS NULL OR p.machine_id = $2::int)
                 AND ($3::text IS NULL OR p.category   = $3::text)
                 AND ($6::text IS NULL
                      OR p.title ILIKE '%' || $6::text || '%'
                      OR p.body  ILIKE '%' || $6::text || '%')
                 AND ($7::int  IS NULL OR p.like_count >= $7::int)
                 AND ($8::text IS NULL OR p.category  <> $8::text)
               ORDER BY ${orderBy(SORT_KEYS[sort])}
               LIMIT $4::int OFFSET $5::int) AS page
       UNION ALL
       SELECT notice.*, true AS is_notice
         FROM (${POST_SELECT}
               WHERE $9::boolean AND p.category = $10::text
               ORDER BY ${orderBy(NOTICE_KEYS)}
               LIMIT $11::int) AS notice`,
      [playerId, tab, category, limit, offset, term, minLikes, excluded, pinNotices, NOTICE_CATEGORY, NOTICE_PIN_LIMIT],
    ),
    countPosts(tab, category, term, minLikes, excluded),
  ]);

  // UNION ALL 은 두 갈래의 행 순서를 보장하지 않습니다 — Append 가 순서대로 붙이는 것은
  // 구현 사실일 뿐이고, 병렬 Append 가 걸리면 섞입니다. 갈래별로 SQL 과 같은 키로
  // 다시 세웁니다. 합쳐서 많아야 20 + NOTICE_PIN_LIMIT 행이라 비용은 없습니다.
  const pageRows = rows.filter((r) => !r.is_notice).sort(byKeysDesc(SORT_KEYS[sort]));
  const noticeRows = rows.filter((r) => r.is_notice).sort(byKeysDesc(NOTICE_KEYS));

  return {
    posts: pageRows.map(toSummary),
    notices: noticeRows.map(toSummary),
    total,
    hasMore: offset + pageRows.length < total,
  };
}

/**
 * 여러 키 내림차순 비교자. created_at 은 Date, id·like_count·comment_count 는 number 로
 * 오는데, 둘 다 `<` `>` 로 비교됩니다 (Date 는 valueOf 를 거칩니다).
 */
function byKeysDesc(keys: string[]) {
  return (a: Record<string, unknown>, b: Record<string, unknown>): number => {
    for (const k of keys) {
      const x = a[k] as number;
      const y = b[k] as number;
      if (x < y) return 1;
      if (x > y) return -1;
    }
    return 0;
  };
}

/**
 * 조건에 맞는 글의 총계. 페이지 번호 UI 가 이 값으로 페이지 수를 셉니다.
 *
 * **총계는 본질적으로 조건에 맞는 행을 전부 봐야 합니다.** 5만 건이면 매번 5.7ms 씩
 * 드는데, 글 목록은 자주 열리는 화면이라 그게 그대로 쌓입니다. 그래서 캐시합니다 —
 * 인자(필터 조합)가 곧 캐시 키라 탭·말머리·검색어별로 따로 잡힙니다.
 *
 * 30초는 짧게 잡은 값입니다. 글이 늘거나 줄면 아래 invalidatePostCounts 가 즉시
 * 비우므로, TTL 이 실제로 쓰이는 건 추천 수가 바뀌어 '인기글' 기준선을 넘나드는
 * 경우 정도입니다 (그 정도 지연은 페이지 수에 영향이 거의 없습니다).
 */
const countPosts = cacheReference(countPostsUncached, 'post-count', 30_000);

/**
 * 글이 늘거나 줄거나 분류가 바뀌면 총계가 달라집니다. 어느 필터 조합이 영향을
 * 받는지 알 수 없으므로 총계 캐시를 통째로 비웁니다 (항목이 몇 개뿐이라 쌉니다).
 */
function invalidatePostCounts(): void {
  clearReferenceCache('post-count');
}

async function countPostsUncached(
  tab: number | null,
  category: string | null,
  term: string | null,
  minLikes: number | null,
  excluded: string | null,
): Promise<number> {
  const db = await getDb();
  const { rows } = await db.query<{ total: unknown }>(
    `SELECT COUNT(*)::int AS total FROM posts p
     WHERE ($1::int  IS NULL OR p.machine_id = $1::int)
       AND ($2::text IS NULL OR p.category   = $2::text)
       AND ($3::text IS NULL
            OR p.title ILIKE '%' || $3::text || '%'
            OR p.body  ILIKE '%' || $3::text || '%')
       AND ($4::int  IS NULL OR p.like_count >= $4::int)
       AND ($5::text IS NULL OR p.category  <> $5::text)`,
    [tab, category, term, minLikes, excluded],
  );
  return num(rows[0]?.total ?? 0);
}

// ─── 홈 소식 ─────────────────────────────────────────────────

/**
 * 홈 소식 줄에 세울 말머리 — **소식인 것만**.
 *
 * 자유·질문·공략은 뺍니다. 셋 다 사람들이 주고받는 이야기지, 새로 생긴 일이
 * 아닙니다. 홈은 "그동안 뭐가 바뀌었나" 를 묻는 자리라 기준이 다릅니다.
 *
 * 순서는 화면 순서가 아니라 목록일 뿐입니다 — 정렬은 아래 쿼리가 최신순으로 합니다.
 */
export const NEWS_CATEGORIES = [NOTICE_CATEGORY, 'contest', 'info'] as const;

/**
 * 홈 소식 — listPosts 를 쓰지 않고 따로 둡니다.
 *
 * listPosts 는 공지를 목록 위에 따로 고정하고, 게임 탭·검색·인기 기준선을 함께
 * 다룹니다(위 주석들 참고). 홈은 그 어느 것도 필요 없고 **여러 말머리를 한 번에**
 * 받아야 하는데, 그 조건을 listPosts 에 밀어 넣으면 커뮤니티 목록의 공지 고정
 * 규칙과 얽힙니다. 읽기 전용에 조건이 하나뿐이라 따로 두는 쪽이 싸고 안전합니다.
 *
 * playerId 를 넘기지 않습니다 — 홈에는 추천 표시가 없고, 넣으면 사람마다 다른
 * 응답이 되어 나중에 캐시를 걸 수 없습니다.
 */
export async function listNews(limit = 6): Promise<PostSummary[]> {
  const db = await getDb();
  const { rows } = await db.query<Record<string, unknown>>(
    `${POST_SELECT}
      WHERE p.category = ANY($2::text[])
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT $3::int`,
    [null, [...NEWS_CATEGORIES], Math.min(Math.max(limit, 1), 20)],
  );
  return rows.map(toSummary);
}

// ─── 글 상세 ─────────────────────────────────────────────────

/**
 * json_agg 로 실려 온 타임스탬프.
 *
 * 드라이버가 파싱해 주는 컬럼과 달리 json 안에서는 문자열로 옵니다
 * (`2026-09-08T10:00:00+00:00`). 컬럼은 전부 TIMESTAMPTZ 이므로 오프셋이 붙어
 * 있어 Date 로 다시 읽어도 어긋나지 않습니다 — 이 재파싱이 `iso()` 가 Date 에서
 * 만들던 것과 **같은 문자열**을 보장합니다 (응답 형식이 바뀌면 안 됩니다).
 */
function isoFromJson(v: unknown): string {
  return new Date(String(v)).toISOString();
}

/**
 * 글 상세 — 글·댓글·첨부·조회수 +1 을 **한 번의 왕복**으로.
 *
 * 댓글은 전부가 아니라 `commentOffset` 부터 한 페이지만 실립니다 — 전체 개수는
 * 캐시 컬럼(comment_count)에 있으므로 화면이 페이지 수를 계산할 수 있고, 댓글
 * 500개짜리 글이 500개를 다 내려보내지 않습니다.
 *
 * ─── 왜 한 쿼리인가 ───
 * 예전에는 세 번 나눠 갔습니다: 조회수 UPDATE → 글 SELECT → (댓글 ∥ 첨부).
 * 앞의 둘이 순차인 이유가 offset 보정 때문이었습니다 — 댓글 페이지를 당기려면
 * comment_count 를 먼저 알아야 했습니다.
 *
 * 200 VU 측정에서 병목은 SQL 실행이 아니라 **풀 슬롯을 잡고 있는 시간**이었고
 * (PERFORMANCE.md 2부), 그러면 왕복 수가 곧 비용입니다. offset 보정을 SQL 로
 * 옮기면(`comment_offset` 식) 셋을 한 문장에 담을 수 있습니다.
 *
 * ⚠ 조회수는 `bumped` CTE 의 RETURNING 값을 씁니다. 데이터 변경 CTE 의 결과는
 *   **같은 문장의 다른 부분에 보이지 않으므로**(스냅샷이 문장 시작 시점에 고정)
 *   p.view_count 를 그냥 읽으면 올리기 전 값이 나옵니다. 나눠 보내던 때와 응답이
 *   같아야 하므로 RETURNING 쪽을 우선합니다.
 */
export async function getPost(
  postId: number,
  playerId: number | null,
  commentOffset = 0,
  /** true 면 조회수 +1. 목록에서 상세를 열 때만 (수정·추천 후 재조회에는 안 붙임) */
  countView = false,
): Promise<PostDetail | null> {
  const db = await getDb();
  const { rows } = await db.query<Record<string, unknown>>(
    `WITH bumped AS (
       UPDATE posts SET view_count = view_count + 1
        WHERE id = $2::int AND $5::boolean
        RETURNING id, view_count
     ),
     base AS (
       SELECT src.*,
              b.view_count AS view_count_bumped,
              -- clampOffset 과 같은 계산. 정수 나눗셈이 내림이라 한 줄로 떨어진다:
              -- 댓글 15개 · 페이지 10 이면 마지막 페이지 시작은 (14/10)*10 = 10.
              LEAST(
                GREATEST($3::int, 0),
                (GREATEST(src.comment_count - 1, 0) / $4::int) * $4::int
              ) AS comment_offset
         FROM (${POST_SELECT} WHERE p.id = $2::int) src
         LEFT JOIN bumped b ON b.id = src.id
     )
     SELECT base.*,
       -- 갈래마다 json_agg 의 ORDER BY 를 다시 적는다. 서브쿼리의 ORDER BY 가
       -- 집계 입력 순서로 이어지는 것은 구현 사실일 뿐이라, 순서를 결과에 못
       -- 박으려면 집계 쪽에도 같은 키를 준다 (listPosts 의 UNION ALL 과 같은 이유).
       COALESCE((
         SELECT json_agg(c ORDER BY c.created_at, c.id)
           FROM (SELECT pc.id, pc.post_id, pc.player_id, pc.body,
                        pc.created_at, pc.updated_at, cpl.nickname
                   FROM post_comments pc
                   JOIN players cpl ON cpl.id = pc.player_id
                  WHERE pc.post_id = $2::int
                  ORDER BY pc.created_at, pc.id
                  -- OFFSET 에는 이 질의 층의 컬럼을 쓸 수 없어 스칼라 서브쿼리로
                  -- 받는다 (base 는 한 행이다).
                  LIMIT $4::int OFFSET (SELECT comment_offset FROM base)) c
       ), '[]'::json) AS comments,
       COALESCE((
         SELECT json_agg(a ORDER BY a.sort_order, a.id)
           FROM (SELECT pi.id, pi.bytes, pi.mime, pi.sort_order
                   FROM post_images pi
                  WHERE pi.post_id = $2::int) a
       ), '[]'::json) AS attachments
       FROM base`,
    [playerId, postId, commentOffset, COMMENTS_PAGE_SIZE, countView],
  );
  if (!rows[0]) return null;

  const r = rows[0];
  // thumbnail 은 상세에서 빼고 attachments 로 대신한다 (board-types.ts PostDetail 주석).
  const { excerpt: _excerpt, thumbnail: _thumbnail, ...summary } = toSummary(r);
  // 조회수를 올린 요청에서는 올린 뒤의 값이 따로 온다 (위 ⚠ 참고).
  if (r.view_count_bumped !== null && r.view_count_bumped !== undefined) {
    summary.viewCount = num(r.view_count_bumped);
  }

  const comments = (r.comments as Record<string, unknown>[]).map((c) => ({
    id: num(c.id),
    postId: num(c.post_id),
    playerId: num(c.player_id),
    nickname: c.nickname as string,
    body: c.body as string,
    createdAt: isoFromJson(c.created_at),
    updatedAt: isoFromJson(c.updated_at),
  }));

  const attachments: PostAttachment[] = (r.attachments as Record<string, unknown>[]).map((a) => ({
    id: num(a.id),
    // 파일은 public/ 이 아니라 이 라우트로만 나간다 (lib/uploads.ts 참고).
    url: attachmentUrl(num(a.id)),
    bytes: num(a.bytes),
    // 사진인지 동영상인지를 가리는 값 — 화면이 <img>/<video> 를 이걸 보고 고른다.
    mime: a.mime as string,
  }));

  return {
    ...summary,
    machineName: (r.machine_name as string | null) ?? null,
    body: r.body as string,
    bodyDoc: docFromDb(r.body_doc),
    attachments,
    comments,
    commentOffset: num(r.comment_offset),
  };
}

/** offset 을 [0, 마지막 페이지 시작] 안으로 맞춘다 */
function clampOffset(offset: number, total: number, pageSize: number): number {
  if (offset <= 0 || total === 0) return 0;
  const lastStart = Math.floor(Math.max(0, total - 1) / pageSize) * pageSize;
  return Math.min(offset, lastStart);
}

/** 마지막 댓글 페이지의 시작 위치. 댓글을 쓴 뒤 그 페이지로 보내는 데 씁니다. */
export function lastCommentOffset(commentCount: number): number {
  return clampOffset(Number.MAX_SAFE_INTEGER, commentCount, COMMENTS_PAGE_SIZE);
}

/**
 * 조회수에 대하여 — 올리는 것은 getPost 의 `countView` 가 같은 왕복에서 합니다.
 *
 * 조회 로그를 남기지 않으므로 되돌릴 수 없는 누적 카운터입니다. 같은 사람이 새로
 * 고칠 때마다 오르는 것도 막지 않습니다 — 막으려면 (글, 사람, 시각) 을 저장해야 하고,
 * 그건 정확도가 이 값의 용도(목록에서 대충 눈에 띄는 순서)에 비해 과합니다.
 *
 * ⚠ dev 서버는 React Strict Mode 로 effect 를 두 번 실행하므로 개발 중에는 2씩 오릅니다.
 */

// ─── 쓰기 ────────────────────────────────────────────────────

/** 댓글/추천 수 캐시 갱신. 댓글·추천이 바뀔 때마다 호출. */
async function recalc(postId: number): Promise<void> {
  const db = await getDb();
  await db.query(`SELECT recalc_post_stats($1)`, [postId]);
}

/**
 * 문서 → jsonb 파라미터.
 *
 * 객체를 그대로 넘기지 않고 문자열로 넘깁니다 — 객체를 jsonb 로 보내는 규칙이
 * 드라이버마다 다르고(PGlite 와 node-postgres), 문자열 + `::jsonb` 캐스트는
 * 양쪽에서 같게 동작합니다.
 */
function docToDb(doc: RichDoc | null): string | null {
  return doc ? JSON.stringify(doc) : null;
}

export interface PostInput {
  /** null = 게임에 속하지 않는 글 (공지). 규칙은 lib/validation.ts 가 지킨다 */
  machineId: number | null;
  category: string;
  playerId: number;
  /** 본문 안의 [[image:N]] 마커가 어떤 이미지를 어디에 붙일지의 유일한 근거 */
  body: string;
  /**
   * 서식 있는 본문. null 이면 서식 없는 글입니다.
   *
   * `body` 는 이 문서의 평문 투영본이어야 합니다 — 어긋나지 않도록 서버가
   * 문서에서 다시 만듭니다 (lib/validation.ts postInputSchema).
   */
  bodyDoc: RichDoc | null;
  title: string;
}

/**
 * 본문 마커에 등장한 첨부(사진·동영상)를 글에 붙이고, 사라진 것은 떼어 냅니다.
 * 본문에서 지우면 마커도 사라지므로 자동으로 분리됩니다.
 *
 * `player_id = 올린 사람` 조건이 핵심입니다 — 없으면 남이 올린 파일의 id 를
 * 본문에 적어서 자기 글에 끌어다 붙일 수 있습니다.
 *
 * 떼어 낸 첨부는 지우지 않고 post_id 를 NULL 로 되돌립니다. 같은 파일을 다시
 * 붙일 수도 있고, 파일과 행을 함께 정리하는 배치를 나중에 붙이는 쪽이 낫습니다
 * (post_images_orphan_idx 가 그걸 위한 인덱스입니다).
 */
async function syncAttachments(
  tx: Queryable,
  postId: number,
  playerId: number,
  attachmentIds: number[],
): Promise<void> {
  await tx.query(
    `UPDATE post_images SET post_id = NULL
     WHERE post_id = $1 AND NOT (id = ANY($2::int[]))`,
    [postId, attachmentIds],
  );

  for (const [index, attachmentId] of attachmentIds.entries()) {
    await tx.query(
      `UPDATE post_images SET post_id = $1, sort_order = $2
       WHERE id = $3 AND player_id = $4 AND (post_id IS NULL OR post_id = $1)`,
      [postId, index, attachmentId, playerId],
    );
  }
}

export async function createPost(input: PostInput): Promise<number> {
  const db = await getDb();
  // 글 삽입과 이미지 연결은 한 트랜잭션. 따로 하면 "글은 있는데 이미지가
  // 안 붙은" 상태가 남고, 사용자는 이미지를 다시 올려야 한다.
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<{ id: number }>(
      `INSERT INTO posts (machine_id, category, player_id, title, body, body_doc)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING id`,
      [
        input.machineId,
        input.category,
        input.playerId,
        input.title,
        input.body,
        docToDb(input.bodyDoc),
      ],
    );
    const id = rows[0].id;
    await syncAttachments(tx, id, input.playerId, attachmentIdsInBody(input.body));
    invalidatePostCounts();
    return id;
  });
}

/** 작성자 본인만. 다른 사람이면 false. */
export async function updatePost(
  postId: number,
  playerId: number,
  input: PostInput,
): Promise<boolean> {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<{ id: number }>(
      `UPDATE posts SET machine_id = $3, category = $4, title = $5, body = $6,
              body_doc = $7::jsonb, updated_at = now()
       WHERE id = $1 AND player_id = $2
       RETURNING id`,
      [
        postId,
        playerId,
        input.machineId,
        input.category,
        input.title,
        input.body,
        docToDb(input.bodyDoc),
      ],
    );
    if (rows.length === 0) return false;
    await syncAttachments(tx, postId, playerId, attachmentIdsInBody(input.body));
    // 말머리·게임 탭이 바뀌면 어느 조합의 총계가 달라졌는지 알 수 없다.
    invalidatePostCounts();
    return true;
  });
}

// ─── 업로드 ──────────────────────────────────────────────────

/** 업로드 직후, 아직 글에 붙지 않은 첨부 행을 만든다 */
export async function createAttachment(input: {
  playerId: number;
  storageKey: string;
  mime: string;
  bytes: number;
}): Promise<PostAttachment> {
  const db = await getDb();
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO post_images (player_id, storage_key, mime, bytes)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [input.playerId, input.storageKey, input.mime, input.bytes],
  );
  const id = num(rows[0].id);
  return { id, url: `/api/uploads/${id}`, bytes: input.bytes, mime: input.mime };
}

export async function getAttachment(
  attachmentId: number,
): Promise<{ storageKey: string; mime: string } | null> {
  const db = await getDb();
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT storage_key, mime FROM post_images WHERE id = $1`,
    [attachmentId],
  );
  if (!rows[0]) return null;
  return { storageKey: rows[0].storage_key as string, mime: rows[0].mime as string };
}

/**
 * 본인 글 삭제. 작성자 확인이 `WHERE` 절 안에 있습니다 — 조회로 확인한 뒤
 * 지우면 그 사이가 비고, 무엇보다 확인을 빠뜨린 호출부가 조용히 남의 글을
 * 지울 수 있게 됩니다.
 */
export async function deletePost(postId: number, playerId: number): Promise<boolean> {
  const db = await getDb();
  // 댓글·추천은 ON DELETE CASCADE 로 함께 정리된다.
  const { rows } = await db.query<{ id: number }>(
    `DELETE FROM posts WHERE id = $1 AND player_id = $2 RETURNING id`,
    [postId, playerId],
  );
  if (rows.length) invalidatePostCounts();
  return rows.length > 0;
}

/**
 * 관리자 삭제 — 작성자를 보지 않습니다.
 *
 * `deletePost(id, null)` 로 합치지 않은 이유: playerId 에 null 이 들어오면
 * 소유자 검사가 사라지는 함수는, 어딘가에서 playerId 가 실수로 null 이 되는
 * 순간 조용히 만능 삭제가 됩니다. 이름을 나눠 호출부에서 의도가 보이게 합니다.
 */
export async function deletePostAsAdmin(postId: number): Promise<boolean> {
  const db = await getDb();
  const { rows } = await db.query<{ id: number }>(
    `DELETE FROM posts WHERE id = $1 RETURNING id`,
    [postId],
  );
  if (rows.length) invalidatePostCounts();
  return rows.length > 0;
}

export async function createComment(input: {
  postId: number;
  playerId: number;
  body: string;
}): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO post_comments (post_id, player_id, body) VALUES ($1, $2, $3)`,
    [input.postId, input.playerId, input.body],
  );
  await recalc(input.postId);
}

/** 본인 댓글 삭제. 반환값은 그 댓글이 달려 있던 글의 id (없으면 null) */
export async function deleteComment(
  commentId: number,
  playerId: number,
): Promise<number | null> {
  const db = await getDb();
  const { rows } = await db.query<{ post_id: number }>(
    `DELETE FROM post_comments WHERE id = $1 AND player_id = $2 RETURNING post_id`,
    [commentId, playerId],
  );
  if (!rows[0]) return null;
  const postId = num(rows[0].post_id);
  await recalc(postId);
  return postId;
}

/** 관리자 댓글 삭제 — 작성자를 보지 않습니다 (deletePostAsAdmin 주석 참고) */
export async function deleteCommentAsAdmin(commentId: number): Promise<number | null> {
  const db = await getDb();
  const { rows } = await db.query<{ post_id: number }>(
    `DELETE FROM post_comments WHERE id = $1 RETURNING post_id`,
    [commentId],
  );
  if (!rows[0]) return null;
  const postId = num(rows[0].post_id);
  await recalc(postId);
  return postId;
}

/**
 * 추천을 **원하는 상태로 맞춥니다.** 뒤집지 않습니다.
 *
 * 예전에는 `toggleLike` 였습니다 — DB 의 현재 상태를 보고 반대로 바꿨습니다.
 * 그게 재시도에 취약합니다: 모바일에서 응답을 못 받고 재전송하거나 두 번 탭하면
 * 두 번 뒤집혀 원래대로 돌아갑니다. 그 수가 인기글 정렬의 근거입니다.
 *
 * `setClear` · `setSpecial` 이 이미 같은 모양(원하는 상태를 받음)이라 결도 맞습니다.
 * 두 번 불러도 결과가 같으므로 라우트를 PUT/DELETE 로 열 수 있습니다.
 */
export async function setLike(
  postId: number,
  playerId: number,
  liked: boolean,
): Promise<{ liked: boolean }> {
  const db = await getDb();
  if (liked) {
    await db.query(
      `INSERT INTO post_likes (post_id, player_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [postId, playerId],
    );
  } else {
    await db.query(`DELETE FROM post_likes WHERE post_id = $1 AND player_id = $2`, [
      postId,
      playerId,
    ]);
  }
  await recalc(postId);
  return { liked };
}
