'use client';

import Link from 'next/link';

import { useCallback, useEffect, useState } from 'react';
import { COMMENTS_PAGE_SIZE, type PostDetail, type PostSummary } from '@/lib/board-types';
import { timeAgo } from '@/lib/community-types';
import {
  POST_STALE_MS,
  fetchPost,
  forgetPost,
  needsViewCount,
  peekPost,
  rememberPost,
} from '@/lib/post-cache';
import { usePlayerId } from '@/lib/use-player';
import { useIsAdmin } from '@/lib/use-session';
import EmoticonPicker from './EmoticonPicker';
import EmoticonText from './EmoticonText';
import Pagination from './Pagination';
import PostBody from './PostBody';

interface Props {
  postId: number;
  /**
   * 목록이 이미 알고 있던 요약. 있으면 응답을 기다리는 동안 **이걸로 먼저 그립니다**
   * — 제목·글쓴이·시간·추천/댓글/조회 수는 목록과 상세가 같은 값이라, 스피너를
   * 띄우는 것은 이미 가진 것을 숨기는 셈입니다. 본문과 댓글만 자리를 비웁니다.
   *
   * 글쓰기 → 저장 직후처럼 목록을 거치지 않고 들어오는 길에서는 없습니다.
   */
  initial?: PostSummary | null;
  onBack: () => void;
  onEdit: (post: PostDetail) => void;
  onDeleted: () => void;
}

/**
 * 요약만으로 만든 껍데기. 본문·댓글·첨부 자리는 비어 있고, 화면은 `pending` 으로
 * 그 자리에 스켈레톤을 그립니다. 여기서 만든 값이 화면에 **글자로 보이는 일은
 * 없어야** 하므로(빈 본문 등) 채우지 않고 비워 둡니다.
 */
function shellOf(summary: PostSummary): PostDetail {
  // thumbnail 도 뺀다 — 상세의 첨부는 attachments 쪽이다 (lib/board.ts getPost 과 같은 손질).
  // 두면 선언에 없는 키가 붙은 채 PostDetail 행세를 한다.
  const { excerpt: _excerpt, thumbnail: _thumbnail, ...rest } = summary;
  return {
    ...rest,
    machineName: null,
    body: '',
    bodyDoc: null,
    attachments: [],
    comments: [],
    commentOffset: 0,
  };
}

export default function PostDetailView({
  postId,
  initial = null,
  onBack,
  onEdit,
  onDeleted,
}: Props) {
  const playerId = usePlayerId();
  /** 관리자는 남의 글·댓글도 지울 수 있다. 수정은 본인만 — 삭제와 달리 남의
   *  이름으로 남는 글의 내용이 바뀌는 일이라서. 판정은 서버가 한 번 더 한다. */
  const isAdmin = useIsAdmin();

  const [post, setPost] = useState<PostDetail | null>(null);
  /** 1-based. 서버가 범위를 벗어난 페이지를 당겨 주면 그 값으로 맞춘다 */
  const [commentPage, setCommentPage] = useState(1);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 서버가 글이 없다고 답한 상태 (아직 안 온 것과 구분해야 한다) */
  const [missing, setMissing] = useState(false);

  /** 응답의 post 를 반영하고, 서버가 조정한 댓글 페이지로 맞춘다 */
  const applyPost = useCallback(
    (next: PostDetail) => {
      setPost(next);
      setMissing(false);
      // 추천·댓글 뒤의 최신 상태도 담아 둔다 — 뒤로 갔다 다시 들어올 때 쓴다
      rememberPost(
        { postId: next.id, playerId, commentOffset: next.commentOffset },
        next,
      );
      const serverPage = Math.floor(next.commentOffset / COMMENTS_PAGE_SIZE) + 1;
      setCommentPage((prev) => (prev === serverPage ? prev : serverPage));
    },
    [playerId],
  );

  /**
   * 상세를 채운다. 세 갈래다:
   *   1. 담아 둔 것이 있으면 **즉시** 그린다 (미리 받기가 성공한 길 — 대기 0)
   *   2. 오래된 것이면 그린 뒤 조용히 다시 받아 덮는다 (스피너 없음)
   *   3. 없으면 받아 온다 — 그동안 화면은 요약으로 그린 껍데기다
   *
   * 요청은 lib/post-cache.ts 가 키별로 하나만 띄우므로, 미리 받기와 이 마운트가
   * 겹쳐도 두 번 나가지 않는다.
   */
  useEffect(() => {
    let alive = true;
    const key = {
      postId,
      playerId,
      commentOffset: (commentPage - 1) * COMMENTS_PAGE_SIZE,
    };

    const apply = (next: PostDetail | null) => {
      if (!alive) return;
      if (next) applyPost(next);
      else setMissing(true);
    };

    const hit = peekPost(key);
    if (hit) {
      apply(hit.post);
      if (hit.ageMs >= POST_STALE_MS) void fetchPost(key, false).then(apply);
    } else {
      void fetchPost(key, needsViewCount(postId)).then(apply);
    }

    return () => {
      alive = false;
    };
  }, [postId, playerId, commentPage, applyPost]);

  const send = async (url: string, init: RequestInit) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, init);
      if (res.status === 204) return true;
      const data = await res.json();
      if (!res.ok) {
        setError(data.details?.[0] ?? data.error ?? '요청에 실패했습니다');
        return false;
      }
      if (data.post) applyPost(data.post as PostDetail);
      return true;
    } catch {
      setError('네트워크 오류');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const currentOffset = (commentPage - 1) * COMMENTS_PAGE_SIZE;

  /**
   * 추천을 **원하는 상태로** 보냅니다 — 뒤집으라고 하지 않습니다.
   *
   * 예전에는 POST 하나로 토글이었는데, 응답을 못 받고 재전송하거나 두 번 탭하면
   * 두 번 뒤집혀 원래대로 돌아갔습니다 (app/api/posts/[id]/like 주석).
   * PUT/DELETE 는 몇 번 보내도 같은 결과입니다.
   */
  const setLikeTo = (next: boolean) =>
    next
      ? send(`/api/posts/${postId}/like`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          // 추천을 눌렀다고 댓글이 1페이지로 돌아가지 않게 현재 페이지를 알려준다
          body: JSON.stringify({ commentOffset: currentOffset }),
        })
      : send(
          // DELETE 에 본문을 싣지 않는 이유는 라우트 주석 참고 (중간 장비가 버립니다)
          `/api/posts/${postId}/like?commentOffset=${currentOffset}`,
          { method: 'DELETE' },
        );

  /**
   * 고른 이모티콘을 본문 끝에 붙인다.
   *
   * 화면의 maxLength 는 타이핑만 막으므로 여기서 상한을 한 번 더 본다 — 넘겨서
   * 붙이면 저장할 때 서버가 거절하고, 사용자는 왜 거절됐는지 알 수 없다.
   */
  const addEmoticon = (token: string) => {
    setComment((v) => (v.length + token.length > 2000 ? v : v + token));
  };

  const addComment = async () => {
    // 서버가 방금 쓴 댓글이 있는 마지막 페이지를 담아 돌려준다.
    const ok = await send(`/api/posts/${postId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: comment.trim() }),
    });
    if (ok) setComment('');
  };

  // 누가 지우는지는 보내지 않는다 — 본인인지 관리자인지 모두 세션 쿠키가 근거다.
  const removeComment = (commentId: number) =>
    send(
      `/api/posts/${postId}/comments?${new URLSearchParams({
        commentId: String(commentId),
        commentOffset: String(currentOffset),
      })}`,
      { method: 'DELETE' },
    );

  const removePost = async () => {
    if (!confirm('이 글을 삭제할까요? 댓글도 함께 지워지고 되돌릴 수 없습니다.')) return;
    const ok = await send(`/api/posts/${postId}`, {
      method: 'DELETE',
    });
    if (ok) {
      // 담아 둔 것을 지우지 않으면 목록으로 돌아간 뒤 지운 글이 다시 열린다
      forgetPost(postId);
      onDeleted();
    }
  };

  if (missing) return <p className="muted pad">글을 찾을 수 없습니다.</p>;

  /**
   * 화면에 그리는 것 — 받아 온 글이 있으면 그것, 없으면 목록이 준 요약으로 만든
   * 껍데기. 둘 다 없을 때만(글쓰기에서 바로 들어온 첫 순간) 대기 문구를 낸다.
   */
  const shown = post ?? (initial ? shellOf(initial) : null);
  if (!shown) return <p className="muted pad">불러오는 중…</p>;

  /** 본문·댓글이 아직 안 온 상태. 그 자리에만 스켈레톤을 둔다 */
  const pending = post === null;
  const isMine = playerId !== null && shown.playerId === playerId;

  return (
    <article className="post-detail">
      <div className="post-detail-nav">
        <button type="button" className="btn btn-sm" onClick={onBack}>
          글 목록
        </button>
        {(isMine || isAdmin) && (
          <div className="row-actions">
            {isMine && (
              <button
                type="button"
                className="btn btn-sm"
                disabled={pending}
                onClick={() => post && onEdit(post)}
              >
                수정
              </button>
            )}
            <button
              type="button"
              className="btn btn-sm btn-danger"
              disabled={busy}
              title={!isMine && isAdmin ? '관리자 권한으로 남의 글을 삭제합니다' : undefined}
              onClick={removePost}
            >
              삭제
            </button>
          </div>
        )}
      </div>

      <header className="post-detail-head">
        <div className="post-row-head">
          {/* 게임 없는 공지에는 뱃지가 없다 (lib/board-types.ts machineId 주석) */}
          {shown.machineShortName && (
            <span className="badge badge-rhythm" title={shown.machineName ?? undefined}>
              {shown.machineShortName}
            </span>
          )}
          <span className={`cat cat-${shown.category}`}>{shown.categoryLabel}</span>
        </div>
        <h1>{shown.title}</h1>
        <p className="muted small">
          {shown.nickname} · {timeAgo(shown.createdAt)}
          {shown.updatedAt !== shown.createdAt && ` (수정 ${timeAgo(shown.updatedAt)})`} · 조회{' '}
          {shown.viewCount}
        </p>
      </header>

      {/* 첨부는 본문 안 마커 위치에 들어간다 (components/PostBody.tsx).
          본문이 아직 안 왔으면 같은 자리에 상자만 둔다 — 빈 본문을 그리면 아래
          내용이 위로 붙었다가 응답이 오는 순간 아래로 밀린다. */}
      {pending ? (
        <div className="post-skeleton" aria-label="본문 불러오는 중">
          <span />
          <span />
          <span />
        </div>
      ) : (
        <PostBody body={shown.body} bodyDoc={shown.bodyDoc} attachments={shown.attachments} />
      )}

      <div className="post-actions">
        <button
          type="button"
          className={shown.myLike ? 'btn btn-on btn-sm' : 'btn btn-sm'}
          // 본문이 오기 전에 눌러도 서버는 처리하지만, 그 응답이 목록에서 받은
          // 요약을 덮어써서 숫자가 두 번 튄다 — 올 때까지만 막는다.
          disabled={busy || pending || !playerId}
          title={playerId ? undefined : '로그인이 필요합니다'}
          onClick={() => setLikeTo(!shown.myLike)}
        >
          추천 {shown.likeCount}
        </button>
      </div>

      {error && <p className="warn">{error}</p>}

      <section className="section">
        <h3>댓글 {shown.commentCount}개</h3>

        {/* 댓글 수는 요약에 이미 있으므로 제목("댓글 N개")은 처음부터 맞다.
            내용만 안 온 것이니 그 자리에만 상자를 둔다. */}
        {pending ? (
          <div className="post-skeleton" aria-label="댓글 불러오는 중">
            <span />
            <span />
          </div>
        ) : shown.commentCount === 0 ? (
          <p className="muted small">아직 댓글이 없습니다.</p>
        ) : (
          <>
            <ul className="comment-list">
              {shown.comments.map((c, i) => (
                <li key={c.id} className={c.playerId === playerId ? 'is-mine' : ''}>
                  <div className="comment-head">
                    <span className="comment-no muted small">{shown.commentOffset + i + 1}</span>
                    <strong>{c.nickname}</strong>
                    <span className="muted small">{timeAgo(c.createdAt)}</span>
                    {(c.playerId === playerId || isAdmin) && (
                      <button
                        type="button"
                        className="btn btn-sm btn-danger comment-del"
                        disabled={busy}
                        title={
                          c.playerId !== playerId && isAdmin
                            ? '관리자 권한으로 남의 댓글을 삭제합니다'
                            : undefined
                        }
                        onClick={() => removeComment(c.id)}
                      >
                        삭제
                      </button>
                    )}
                  </div>
                  <p className="comment-body"><EmoticonText text={c.body} /></p>
                </li>
              ))}
            </ul>

            <Pagination
              page={commentPage}
              total={shown.commentCount}
              pageSize={COMMENTS_PAGE_SIZE}
              onChange={setCommentPage}
            />
          </>
        )}

        {/* 댓글 목록과 작성 폼은 구분선으로 떼어 놓는다 — 붙어 있으면 마지막 댓글이
            입력창의 일부처럼 읽힌다 (.comment-write 의 border-top / margin) */}
        {!playerId ? (
          <p className="comment-write muted small">
            <Link href="/login?next=%2Fcommunity">로그인</Link>하면 댓글을 쓸 수 있습니다.
          </p>
        ) : (
          <div className="comment-write">
            <div className="comment-form">
              <textarea
                rows={3}
                maxLength={2000}
                placeholder="댓글 남기기"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
              />
              <div className="form-actions">
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={busy || comment.trim().length === 0}
                  onClick={addComment}
                >
                  등록
                </button>
                <EmoticonPicker disabled={busy} onPick={addEmoticon} />
              </div>
            </div>
          </div>
        )}
      </section>
    </article>
  );
}
