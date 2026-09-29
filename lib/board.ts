import type {
  Board,
  BoardCategory,
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
import { Prisma } from './generated/prisma/client.ts';
import { recalcPostStats } from './typed-sql';
import { isRecordNotFound } from './pg-errors';
import { getPrismaClient, iso, TX_OPTIONS, type PrismaTx } from './prisma';
import { normalizeDoc, type RichDoc } from './rich-text';

/**
 * 커뮤니티 게시판.
 *
 * 게임별 탭은 테이블이 아니라 `posts.machine_id` 필터입니다 — '전체' 탭은 필터를
 * 걸지 않은 조회일 뿐이고, 게임을 추가할 때 마이그레이션이 필요 없습니다.
 */

/**
 * jsonb 컬럼 → 문서.
 *
 * **읽을 때도 정규화를 통과시킵니다** — 지금 코드가 넣은 값만 들어 있을 테지만,
 * 스키마가 좁아지는 변경(색 하나를 빼는 것 같은) 뒤에 옛 문서가 그대로 화면까지
 * 흘러가지 않게 하는 그물입니다.
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
  const prisma = await getPrismaClient();
  const rows = await prisma.machines.findMany({
    where: { category: 'rhythm' },
    orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
    select: { id: true, name: true, short_name: true, _count: { select: { posts: true } } },
  });
  return rows.map((r) => ({
    machineId: r.id,
    name: r.name,
    shortName: r.short_name,
    postCount: r._count.posts,
  }));
}

export async function listCategories(): Promise<BoardCategory[]> {
  const prisma = await getPrismaClient();
  const rows = await prisma.board_categories.findMany({
    orderBy: { sort_order: 'asc' },
    select: { code: true, label: true },
  });
  return rows.map((r) => ({ code: r.code, label: r.label }));
}

// ─── 글 목록 ─────────────────────────────────────────────────

/**
 * 글 한 줄에 붙는 관계 (옛 POST_SELECT 의 조인들).
 *
 *   machines          LEFT JOIN — 게임 없는 글(공지)이 목록에서 사라지지 않아야 한다.
 *   post_likes        내 추천 여부. 로그인하지 않았으면 아무 행도 맞지 않는 id(0)로 물어
 *                     LEFT JOIN … player_id = NULL 과 같은 결과를 낸다.
 *   post_images       목록 썸네일 = 이 글의 첫 첨부 한 건. Prisma 는 관계의 take 를 글마다
 *                     LATERAL 로 풀어 post_images_post_idx (post_id, sort_order, id) 를 탄다 —
 *                     첨부가 1개든 5개든 비용이 같다. 사진/영상을 가리지 않는다
 *                     (board-types.ts PostThumbnail).
 */
const postInclude = (playerId: number | null) =>
  ({
    machines: { select: { name: true, short_name: true } },
    board_categories: { select: { label: true } },
    players: { select: { nickname: true } },
    post_likes: { where: { player_id: playerId ?? 0 }, select: { player_id: true } },
    post_images: {
      orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
      take: 1,
      select: { id: true, mime: true },
    },
  }) satisfies Prisma.postsInclude;

type PostRow = Prisma.postsGetPayload<{ include: ReturnType<typeof postInclude> }>;

function toSummary(r: PostRow): PostSummary {
  const thumb = r.post_images[0];
  return {
    id: r.id,
    machineId: r.machine_id,
    machineShortName: r.machines?.short_name ?? null,
    category: r.category,
    categoryLabel: r.board_categories.label,
    playerId: r.player_id,
    nickname: r.players.nickname,
    title: r.title,
    excerpt: excerptOf(r.body),
    // 첨부가 없으면 '썸네일 없음'.
    thumbnail: thumb ? { id: thumb.id, url: attachmentUrl(thumb.id), mime: thumb.mime } : null,
    commentCount: r.comment_count,
    likeCount: r.like_count,
    viewCount: r.view_count,
    myLike: r.post_likes.length > 0,
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

/**
 * 정렬 키. 목록 쿼리와 총계가 **같은 표**를 봅니다. 전부 내림차순입니다.
 * 공지는 정렬 옵션과 무관하게 항상 최신순입니다.
 */
const SORT_ORDER: Record<PostSort, Prisma.postsOrderByWithRelationInput[]> = {
  recent: [{ created_at: 'desc' }, { id: 'desc' }],
  popular: [{ like_count: 'desc' }, { comment_count: 'desc' }, { created_at: 'desc' }],
};

/** 목록과 총계가 같은 조건을 보도록 한 곳에서 만든다 */
function postsWhere(
  tab: number | null,
  category: string | null,
  term: string | null,
  minLikes: number | null,
  excluded: string | null,
): Prisma.postsWhereInput {
  return {
    ...(tab !== null ? { machine_id: tab } : {}),
    ...(category !== null ? { category } : {}),
    ...(term !== null
      ? {
          OR: [
            { title: { contains: term, mode: 'insensitive' } },
            { body: { contains: term, mode: 'insensitive' } },
          ],
        }
      : {}),
    ...(minLikes !== null ? { like_count: { gte: minLikes } } : {}),
    ...(excluded !== null ? { category: { not: excluded } } : {}),
  };
}

export async function listPosts(params: ListPostsParams): Promise<ListPostsResult> {
  const prisma = await getPrismaClient();
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

  // 인기글은 정렬이 아니라 '기준선을 넘은 글만' 이다. 최신순에는 걸지 않는다.
  const minLikes = sort === 'popular' ? POPULAR_MIN_LIKES : null;

  /**
   * 공지를 위에 따로 붙일 조회인가.
   *
   * 공지는 '어느 게임 게시판에 썼는지' 와 무관하게 모든 탭 맨 위에 서야 하므로
   * 필터를 타는 목록에 섞을 수 없다 — 다른 게임 탭이나 다른 말머리를 고르면
   * 조건에서 빠져 사라진다. 그래서 별도 조회로 뽑아 올리고, 본 목록에서는
   * 빼서 같은 글이 두 번 나오지 않게 한다.
   *
   * 두 경우는 예외로 섞어 둔다:
   *   · '공지' 말머리를 직접 고른 조회 — 그 목록 자체가 공지다 (고정+본문 중복).
   *   · 검색(q) — 화면의 검색창과 챗봇이 같이 쓰는 경로다. 찾는 말과 무관한
   *     공지가 결과 앞에 끼면 검색 결과가 아닌 것이 검색 결과처럼 보인다.
   */
  const pinNotices = category !== NOTICE_CATEGORY && term === null;
  const excluded = pinNotices ? NOTICE_CATEGORY : null;

  /**
   * '공지' 말머리를 고르면 게임 탭을 무시한다.
   *
   * 공지는 어느 게시판에 썼든 모든 탭 맨 위에 고정되므로, 사볼 탭에서 방금
   * 위에 붙어 있던 공지가 '공지' 를 누른 순간 "아직 글이 없습니다" 로 바뀌면
   * 같은 화면이 스스로를 부정하는 셈이 된다. 고정과 필터가 같은 목록을 봐야 한다.
   */
  const tab = category === NOTICE_CATEGORY ? null : machineId;

  // category 필터와 excluded 가 둘 다 있으면 Prisma 객체의 같은 키에 겹치므로 AND 로 나눈다.
  const where: Prisma.postsWhereInput =
    category !== null && excluded !== null
      ? { AND: [postsWhere(tab, category, term, minLikes, null), { category: { not: excluded } }] }
      : postsWhere(tab, category, term, minLikes, excluded);

  /**
   * 목록·고정 공지·총계를 **나란히** 가져옵니다.
   *
   * 총계는 캐시(countPosts)로 받습니다 — 조건에 맞는 행을 전부 보는 값이라 매번 세면
   * 5만 행에서 5.7ms 씩 들고, 창 함수로 목록에 합치면 LIMIT 이 인덱스까지 내려가지 못해
   * 24배 느려졌습니다 (PERFORMANCE.md). 목록 자체는 LIMIT 이 인덱스로 내려가는 모양입니다.
   *
   * 옛 SQL 은 공지 갈래를 UNION ALL 로 붙여 왕복 하나를 아꼈습니다 — 200 VU 에서 병목이
   * 풀 슬롯 점유 시간이었기 때문입니다. Prisma 에서는 두 조회를 나란히 보냅니다. 지금
   * 기준선(DAU 3,000 · 피크 3.4 req/s, lib/… k6)에서는 왕복 하나가 재이지 않습니다.
   */
  const [pageRows, noticeRows, total] = await Promise.all([
    prisma.posts.findMany({
      where,
      orderBy: SORT_ORDER[sort],
      take: limit,
      skip: offset,
      include: postInclude(playerId),
    }),
    pinNotices
      ? prisma.posts.findMany({
          where: { category: NOTICE_CATEGORY },
          orderBy: SORT_ORDER.recent,
          take: NOTICE_PIN_LIMIT,
          include: postInclude(playerId),
        })
      : Promise.resolve([] as PostRow[]),
    countPosts(tab, category, term, minLikes, excluded),
  ]);

  return {
    posts: pageRows.map(toSummary),
    notices: noticeRows.map(toSummary),
    total,
    hasMore: offset + pageRows.length < total,
  };
}

/**
 * 조건에 맞는 글의 총계. 페이지 번호 UI 가 이 값으로 페이지 수를 셉니다.
 *
 * **총계는 본질적으로 조건에 맞는 행을 전부 봐야 합니다.** 글 목록은 자주 열리는
 * 화면이라 그게 그대로 쌓입니다. 그래서 캐시합니다 — 인자(필터 조합)가 곧 캐시 키라
 * 탭·말머리·검색어별로 따로 잡힙니다.
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
  const prisma = await getPrismaClient();
  const where: Prisma.postsWhereInput =
    category !== null && excluded !== null
      ? { AND: [postsWhere(tab, category, term, minLikes, null), { category: { not: excluded } }] }
      : postsWhere(tab, category, term, minLikes, excluded);
  return prisma.posts.count({ where });
}

// ─── 홈 소식 ─────────────────────────────────────────────────

/**
 * 홈 소식 줄에 세울 말머리 — **소식인 것만**.
 *
 * 자유·질문·공략은 뺍니다. 셋 다 사람들이 주고받는 이야기지, 새로 생긴 일이
 * 아닙니다. 홈은 "그동안 뭐가 바뀌었나" 를 묻는 자리라 기준이 다릅니다.
 */
export const NEWS_CATEGORIES = [NOTICE_CATEGORY, 'contest', 'info'] as const;

/**
 * 홈 소식 — listPosts 를 쓰지 않고 따로 둡니다.
 *
 * listPosts 는 공지를 목록 위에 따로 고정하고, 게임 탭·검색·인기 기준선을 함께
 * 다룹니다. 홈은 그 어느 것도 필요 없고 **여러 말머리를 한 번에** 받아야 하는데,
 * 그 조건을 listPosts 에 밀어 넣으면 커뮤니티 목록의 공지 고정 규칙과 얽힙니다.
 *
 * playerId 를 넘기지 않습니다 — 홈에는 추천 표시가 없고, 넣으면 사람마다 다른
 * 응답이 되어 나중에 캐시를 걸 수 없습니다.
 */
export async function listNews(limit = 6): Promise<PostSummary[]> {
  const prisma = await getPrismaClient();
  const rows = await prisma.posts.findMany({
    where: { category: { in: [...NEWS_CATEGORIES] } },
    orderBy: SORT_ORDER.recent,
    take: Math.min(Math.max(limit, 1), 20),
    include: postInclude(null),
  });
  return rows.map(toSummary);
}

// ─── 글 상세 ─────────────────────────────────────────────────

/**
 * 글 상세 — 글·댓글 한 페이지·첨부·조회수 +1.
 *
 * 댓글은 전부가 아니라 `commentOffset` 부터 한 페이지만 실립니다 — 전체 개수는
 * 캐시 컬럼(comment_count)에 있으므로 화면이 페이지 수를 계산할 수 있고, 댓글
 * 500개짜리 글이 500개를 다 내려보내지 않습니다.
 *
 * ─── 왕복 수 ───
 * 옛 SQL 은 데이터 변경 CTE 로 셋을 한 문장에 담았습니다(조회수 UPDATE → 글 → 댓글∥첨부).
 * Prisma 에서는 둘입니다 — 글(조회수를 올리는 요청이면 update 가 올린 값을 그대로
 * 돌려줍니다) → 댓글과 첨부를 나란히. offset 보정이 comment_count 를 먼저 알아야 해서
 * 하나로는 안 됩니다. 지금 기준선에서 왕복 하나는 재이지 않습니다 (listPosts 주석).
 */
export async function getPost(
  postId: number,
  playerId: number | null,
  commentOffset = 0,
  /** true 면 조회수 +1. 목록에서 상세를 열 때만 (수정·추천 후 재조회에는 안 붙임) */
  countView = false,
): Promise<PostDetail | null> {
  const prisma = await getPrismaClient();
  const include = postInclude(playerId);

  let post: PostRow | null;
  if (countView) {
    try {
      post = await prisma.posts.update({
        where: { id: postId },
        data: { view_count: { increment: 1 } },
        include,
      });
    } catch (err) {
      if (!isRecordNotFound(err)) throw err;
      post = null;
    }
  } else {
    post = await prisma.posts.findUnique({ where: { id: postId }, include });
  }
  if (!post) return null;

  const offset = clampOffset(commentOffset, post.comment_count, COMMENTS_PAGE_SIZE);
  const [commentRows, attachmentRows] = await Promise.all([
    prisma.post_comments.findMany({
      where: { post_id: postId },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
      skip: offset,
      take: COMMENTS_PAGE_SIZE,
      include: { players: { select: { nickname: true } } },
    }),
    prisma.post_images.findMany({
      where: { post_id: postId },
      orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
      select: { id: true, bytes: true, mime: true },
    }),
  ]);

  // thumbnail 은 상세에서 빼고 attachments 로 대신한다 (board-types.ts PostDetail 주석).
  const { excerpt: _excerpt, thumbnail: _thumbnail, ...summary } = toSummary(post);

  const comments = commentRows.map((c) => ({
    id: c.id,
    postId: c.post_id,
    playerId: c.player_id,
    nickname: c.players.nickname,
    body: c.body,
    createdAt: iso(c.created_at),
    updatedAt: iso(c.updated_at),
  }));

  const attachments: PostAttachment[] = attachmentRows.map((a) => ({
    id: a.id,
    // 파일은 public/ 이 아니라 이 라우트로만 나간다 (lib/uploads.ts 참고).
    url: attachmentUrl(a.id),
    bytes: a.bytes,
    // 사진인지 동영상인지를 가리는 값 — 화면이 <img>/<video> 를 이걸 보고 고른다.
    mime: a.mime,
  }));

  return {
    ...summary,
    machineName: post.machines?.name ?? null,
    body: post.body,
    bodyDoc: docFromDb(post.body_doc),
    attachments,
    comments,
    commentOffset: offset,
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
 * 조회수에 대하여 — 올리는 것은 getPost 의 `countView` 가 합니다.
 *
 * 조회 로그를 남기지 않으므로 되돌릴 수 없는 누적 카운터입니다. 같은 사람이 새로
 * 고칠 때마다 오르는 것도 막지 않습니다 — 막으려면 (글, 사람, 시각) 을 저장해야 하고,
 * 그건 정확도가 이 값의 용도(목록에서 대충 눈에 띄는 순서)에 비해 과합니다.
 *
 * ⚠ dev 서버는 React Strict Mode 로 effect 를 두 번 실행하므로 개발 중에는 2씩 오릅니다.
 */

// ─── 쓰기 ────────────────────────────────────────────────────

/**
 * 댓글/추천 수 캐시 갱신. 댓글·추천이 바뀔 때마다 호출.
 * 집계는 DB 함수 recalc_post_stats 가 합니다 (prisma/sql/recalcPostStats.sql).
 */
async function recalc(postId: number): Promise<void> {
  const prisma = await getPrismaClient();
  await prisma.$queryRawTyped(recalcPostStats(postId));
}

/** 문서 → jsonb. null 이면 SQL NULL (Prisma 는 Json 컬럼의 NULL 을 DbNull 로 구분합니다) */
function docToDb(doc: RichDoc | null): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return doc ? (doc as unknown as Prisma.InputJsonValue) : Prisma.DbNull;
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
  tx: PrismaTx,
  postId: number,
  playerId: number,
  attachmentIds: number[],
): Promise<void> {
  await tx.post_images.updateMany({
    where: { post_id: postId, id: { notIn: attachmentIds } },
    data: { post_id: null },
  });

  for (const [index, attachmentId] of attachmentIds.entries()) {
    await tx.post_images.updateMany({
      where: {
        id: attachmentId,
        player_id: playerId,
        OR: [{ post_id: null }, { post_id: postId }],
      },
      data: { post_id: postId, sort_order: index },
    });
  }
}

export async function createPost(input: PostInput): Promise<number> {
  const prisma = await getPrismaClient();
  // 글 삽입과 이미지 연결은 한 트랜잭션. 따로 하면 "글은 있는데 이미지가
  // 안 붙은" 상태가 남고, 사용자는 이미지를 다시 올려야 한다.
  return prisma.$transaction(async (tx) => {
    const created = await tx.posts.create({
      data: {
        machine_id: input.machineId,
        category: input.category,
        player_id: input.playerId,
        title: input.title,
        body: input.body,
        body_doc: docToDb(input.bodyDoc),
      },
      select: { id: true },
    });
    await syncAttachments(tx, created.id, input.playerId, attachmentIdsInBody(input.body));
    invalidatePostCounts();
    return created.id;
  }, TX_OPTIONS);
}

/** 작성자 본인만. 다른 사람이면 false. */
export async function updatePost(
  postId: number,
  playerId: number,
  input: PostInput,
): Promise<boolean> {
  const prisma = await getPrismaClient();
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.posts.updateMany({
      where: { id: postId, player_id: playerId },
      data: {
        machine_id: input.machineId,
        category: input.category,
        title: input.title,
        body: input.body,
        body_doc: docToDb(input.bodyDoc),
        updated_at: new Date(),
      },
    });
    if (count === 0) return false;
    await syncAttachments(tx, postId, playerId, attachmentIdsInBody(input.body));
    // 말머리·게임 탭이 바뀌면 어느 조합의 총계가 달라졌는지 알 수 없다.
    invalidatePostCounts();
    return true;
  }, TX_OPTIONS);
}

// ─── 업로드 ──────────────────────────────────────────────────

/** 업로드 직후, 아직 글에 붙지 않은 첨부 행을 만든다 */
export async function createAttachment(input: {
  playerId: number;
  storageKey: string;
  mime: string;
  bytes: number;
}): Promise<PostAttachment> {
  const prisma = await getPrismaClient();
  const row = await prisma.post_images.create({
    data: {
      player_id: input.playerId,
      storage_key: input.storageKey,
      mime: input.mime,
      bytes: input.bytes,
    },
    select: { id: true },
  });
  return { id: row.id, url: `/api/uploads/${row.id}`, bytes: input.bytes, mime: input.mime };
}

export async function getAttachment(
  attachmentId: number,
): Promise<{ storageKey: string; mime: string } | null> {
  const prisma = await getPrismaClient();
  const row = await prisma.post_images.findUnique({
    where: { id: attachmentId },
    select: { storage_key: true, mime: true },
  });
  return row ? { storageKey: row.storage_key, mime: row.mime } : null;
}

/**
 * 본인 글 삭제. 작성자 확인이 조건 안에 있습니다 — 조회로 확인한 뒤
 * 지우면 그 사이가 비고, 무엇보다 확인을 빠뜨린 호출부가 조용히 남의 글을
 * 지울 수 있게 됩니다.
 */
export async function deletePost(postId: number, playerId: number): Promise<boolean> {
  const prisma = await getPrismaClient();
  // 댓글·추천은 ON DELETE CASCADE 로 함께 정리된다.
  const { count } = await prisma.posts.deleteMany({ where: { id: postId, player_id: playerId } });
  if (count) invalidatePostCounts();
  return count > 0;
}

/**
 * 관리자 삭제 — 작성자를 보지 않습니다.
 *
 * `deletePost(id, null)` 로 합치지 않은 이유: playerId 에 null 이 들어오면
 * 소유자 검사가 사라지는 함수는, 어딘가에서 playerId 가 실수로 null 이 되는
 * 순간 조용히 만능 삭제가 됩니다. 이름을 나눠 호출부에서 의도가 보이게 합니다.
 */
export async function deletePostAsAdmin(postId: number): Promise<boolean> {
  const prisma = await getPrismaClient();
  const { count } = await prisma.posts.deleteMany({ where: { id: postId } });
  if (count) invalidatePostCounts();
  return count > 0;
}

export async function createComment(input: {
  postId: number;
  playerId: number;
  body: string;
}): Promise<void> {
  const prisma = await getPrismaClient();
  await prisma.post_comments.create({
    data: { post_id: input.postId, player_id: input.playerId, body: input.body },
  });
  await recalc(input.postId);
}

/**
 * 댓글 한 건을 지우고 그 댓글이 달려 있던 글의 id 를 돌려줍니다 (없으면 null).
 * 작성자 조건은 있으면 함께 겁니다 — 지우기 전에 확인하는 것이 아니라 지우는 조건입니다.
 */
async function deleteCommentRow(
  where: { id: number; player_id?: number },
): Promise<number | null> {
  const prisma = await getPrismaClient();
  try {
    const row = await prisma.post_comments.delete({ where, select: { post_id: true } });
    return row.post_id;
  } catch (err) {
    if (isRecordNotFound(err)) return null;
    throw err;
  }
}

/** 본인 댓글 삭제. 반환값은 그 댓글이 달려 있던 글의 id (없으면 null) */
export async function deleteComment(
  commentId: number,
  playerId: number,
): Promise<number | null> {
  const postId = await deleteCommentRow({ id: commentId, player_id: playerId });
  if (postId !== null) await recalc(postId);
  return postId;
}

/** 관리자 댓글 삭제 — 작성자를 보지 않습니다 (deletePostAsAdmin 주석 참고) */
export async function deleteCommentAsAdmin(commentId: number): Promise<number | null> {
  const postId = await deleteCommentRow({ id: commentId });
  if (postId !== null) await recalc(postId);
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
  const prisma = await getPrismaClient();
  if (liked) {
    await prisma.post_likes.createMany({
      data: [{ post_id: postId, player_id: playerId }],
      skipDuplicates: true,
    });
  } else {
    await prisma.post_likes.deleteMany({ where: { post_id: postId, player_id: playerId } });
  }
  await recalc(postId);
  return { liked };
}
