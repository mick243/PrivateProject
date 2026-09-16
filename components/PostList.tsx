'use client';

import Image from 'next/image';
import {
  isVideo,
  POPULAR_MIN_LIKES,
  THUMBNAIL_SIZE,
  type PostSummary,
  type PostThumbnail,
} from '@/lib/board-types';
import { timeAgo } from '@/lib/community-types';

interface Props {
  posts: PostSummary[];
  /**
   * 맨 위에 고정되는 공지. `posts` 와 겹치지 않고 페이지를 넘겨도 그대로 붙어
   * 있습니다 (lib/board.ts listPosts). 공지 말머리를 직접 고른 목록에서는
   * 비어 있습니다 — 그 목록 자체가 공지라서 고정할 이유가 없습니다.
   */
  notices: PostSummary[];
  loading: boolean;
  total: number;
  /** '전체' 탭에서만 게임 뱃지를 보여준다 */
  showGame: boolean;
  /**
   * 인기글 필터가 걸린 상태. 목록이 비었을 때 "첫 글을 남겨 보세요" 라고 하면
   * 거짓말이 된다 — 글은 있고, 추천 기준을 넘은 게 없을 뿐이다.
   */
  popularOnly: boolean;
  /** 검색어가 걸린 상태. popularOnly 와 같은 이유로 빈 목록 문구가 달라진다. */
  searching: boolean;
  /** 요약을 그대로 넘긴다 — 상세가 응답을 기다리는 동안 이걸로 먼저 그린다 */
  onOpen: (post: PostSummary) => void;
  /**
   * 이 글을 곧 열 것 같다 (마우스 버튼을 누른 순간). 상세가 어차피 보낼 요청을
   * 미리 시작하는 데 씁니다 — 누르고 떼는 사이가 그만큼 벌어 주는 시간입니다
   * (lib/post-cache.ts).
   */
  onPrefetch?: (postId: number) => void;
}

interface RowProps {
  post: PostSummary;
  showGame: boolean;
  notice?: boolean;
  onOpen: (post: PostSummary) => void;
  onPrefetch?: (postId: number) => void;
}

/**
 * 목록 행의 썸네일 — 그 글의 첫 첨부 (lib/board-types.ts PostThumbnail).
 *
 * ─── 사진: next/image 를 거친다 ───
 * 첨부는 원본 그대로 저장됩니다 — 폰 사진 한 장이 3~5MB 라, `<img>` 로 그대로 걸면
 * 72px 짜리 네모 하나를 그리려고 한 화면에 수십 MB 를 받습니다. next/image 는 요청
 * 시점에 줄여서 webp 로 내보내고 그 결과를 디스크에 캐시하므로, 저장 방식을 바꾸지
 * 않고도 목록이 가벼워집니다 (한 행당 수 KB).
 *
 * 폭·높이를 상수로 박을 수 있는 것이 여기서만 next/image 를 쓸 수 있는 이유입니다.
 * 본문 첨부(components/PostMedia.tsx)는 원본 비율로 그려야 해서 크기를 미리 못 주고,
 * 그래서 지금도 평범한 `<img>` 입니다.
 *
 * ⚠ 움직이는 GIF 는 Next 가 최적화하지 않고 원본을 그대로 내보냅니다. 업로드 시
 *   썸네일을 만드는 쪽으로 가기 전에는(README '이미지 리사이즈/썸네일') 그 한 종류만
 *   무겁습니다.
 *
 * ─── 동영상: 파일을 아예 받지 않는다 ───
 * 영상에서 한 프레임을 뽑으려면 파일을 받아야 하는데, 상한이 50MB 입니다. 목록에서는
 * 그럴 수 없으므로 재생 표시만 있는 네모를 둡니다 — '첨부가 있는 글' 이라는 신호는
 * 그것으로 충분합니다.
 */
function PostThumb({ thumbnail }: { thumbnail: PostThumbnail }) {
  if (isVideo(thumbnail.mime)) {
    return (
      <div className="post-thumb post-thumb-video" role="img" aria-label="동영상 첨부">
        <span aria-hidden="true">▶</span>
      </div>
    );
  }

  return (
    <Image
      className="post-thumb"
      src={thumbnail.url}
      // 제목·본문 미리보기가 이미 그 글을 말한다 — 썸네일은 같은 것을 두 번 읽게
      // 하는 장식이므로 빈 alt 로 두어 화면 낭독기가 건너뛰게 한다.
      alt=""
      width={THUMBNAIL_SIZE}
      height={THUMBNAIL_SIZE}
    />
  );
}

function PostRow({ post: p, showGame, notice = false, onOpen, onPrefetch }: RowProps) {
  return (
    <li
      className={notice ? 'is-notice' : undefined}
      onClick={() => onOpen(p)}
      // 마우스일 때만. 터치의 pointerdown 은 스크롤의 시작일 수도 있고, 이 요청은
      // 조회수를 올리므로 스쳐 지나간 글의 수가 오르면 안 된다 (post-cache.ts).
      onPointerDown={(e) => {
        if (e.pointerType === 'mouse') onPrefetch?.(p.id);
      }}
    >
      {/* 글자 칸과 썸네일 칸. 첨부가 없는 글은 썸네일 칸 자체가 없어서 글자가 폭을
          다 쓴다 — 빈 자리를 남겨 두면 첨부 없는 글이 대부분인 게시판에서 오른쪽이
          통째로 비어 보인다. */}
      <div className="post-row">
        <div className="post-row-body">
          <div className="post-row-head">
            {/* 게임 없는 글(공지)은 뱃지 자리를 비워 둔다 — machineShortName 이 null 이다 */}
            {showGame && p.machineShortName && (
              <span className="badge badge-rhythm">{p.machineShortName}</span>
            )}
            <span className={`cat cat-${p.category}`}>{p.categoryLabel}</span>
            {/* 제목이 곧 이 글을 여는 버튼 — ArcadeList 와 같은 이유 (접근성 P1).
                줄 클릭(li onClick)은 마우스 편의로 그대로 둔다. */}
            <h3>
              <button
                type="button"
                className="row-title"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpen(p);
                }}
              >
                {p.title}
              </button>
            </h3>
          </div>

          <p className="post-excerpt">{p.excerpt}</p>

          <div className="post-meta muted small">
            <span>{p.nickname}</span>
            <span>{timeAgo(p.createdAt)}</span>
            <span className={p.myLike ? 'stat-like is-on' : 'stat-like'}>추천 {p.likeCount}</span>
            <span>댓글 {p.commentCount}</span>
            <span>조회 {p.viewCount}</span>
          </div>
        </div>

        {p.thumbnail && <PostThumb thumbnail={p.thumbnail} />}
      </div>
    </li>
  );
}

/**
 * 목록이 비었을 때 뭐라고 할지. 걸린 조건마다 이유가 다르므로 문구도 달라야
 * 한다 — 어느 경우든 "아직 글이 없습니다" 로 뭉치면, 사용자는 조건을 풀어 보는
 * 대신 게시판이 비었다고 믿고 나간다.
 */
function emptyMessage(searching: boolean, popularOnly: boolean): string {
  if (searching && popularOnly)
    return `추천 ${POPULAR_MIN_LIKES}개 이상 받은 글 중에는 검색 결과가 없습니다.`;
  if (searching) return '검색 결과가 없습니다.';
  if (popularOnly) return `추천 ${POPULAR_MIN_LIKES}개 이상 받은 글이 아직 없습니다.`;
  return '아직 글이 없습니다. 이 게시판의 첫 글을 남겨 보세요.';
}

export default function PostList({
  posts,
  notices,
  loading,
  total,
  showGame,
  popularOnly,
  searching,
  onOpen,
  onPrefetch,
}: Props) {
  if (loading && posts.length === 0 && notices.length === 0)
    return <p className="muted pad">불러오는 중…</p>;

  return (
    <>
      {notices.length > 0 && (
        <>
          {/* 고정 공지는 게임 뱃지를 달지 않는다 — 모든 게임 탭에 같이 뜨므로
              "어느 게시판에 썼는지" 는 읽는 사람에게 뜻이 없고, 다른 게임 탭에서는
              엉뚱한 뱃지로 보인다. */}
          <ul className="post-list">
            {notices.map((p) => (
              <PostRow
                key={p.id}
                post={p}
                showGame={false}
                notice
                onOpen={onOpen}
                onPrefetch={onPrefetch}
              />
            ))}
          </ul>

          {/* 공지와 일반 글을 가르는 굵은 선 */}
          <div className="notice-rule" />
        </>
      )}

      {posts.length === 0 ? (
        <p className="muted pad">{emptyMessage(searching, popularOnly)}</p>
      ) : (
        <ul className="post-list">
          {posts.map((p) => (
            <PostRow
              key={p.id}
              post={p}
              showGame={showGame}
              onOpen={onOpen}
              onPrefetch={onPrefetch}
            />
          ))}
        </ul>
      )}
    </>
  );
}
