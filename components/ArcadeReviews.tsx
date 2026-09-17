'use client';

import Link from 'next/link';

import { Fragment, useCallback, useEffect, useState } from 'react';
import { REVIEWS_PAGE_SIZE, timeAgo, type ArcadeReview } from '@/lib/community-types';
import {
  REVIEW_SUMMARY_KEYS,
  REVIEW_SUMMARY_MIN,
  type ReviewSummaryView,
} from '@/lib/review-summary-types';
import { totalPagesOf } from '@/lib/board-types';
import type { Arcade } from '@/lib/types';
import { usePlayerId } from '@/lib/use-player';
import EmoticonPicker from './EmoticonPicker';
import EmoticonText from './EmoticonText';
import Pagination from './Pagination';
import StarRating from './StarRating';

interface Props {
  arcade: Arcade;
  onArcadeChanged: (arcade: Arcade) => void;
}

export default function ArcadeReviews({ arcade, onArcadeChanged }: Props) {
  const playerId = usePlayerId();

  const [reviews, setReviews] = useState<ArcadeReview[]>([]);
  const [rating, setRating] = useState(0);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 1-based. 목록이 줄어 지금 쪽이 비면 마지막 쪽으로 당깁니다 (아래 clamp) */
  const [page, setPage] = useState(1);

  /**
   * AI 요약. 리뷰가 REVIEW_SUMMARY_MIN 개 이상일 때만 묻습니다.
   * 첫 사람은 만드는 데 몇 초가 걸리므로 '만드는 중' 을 따로 보여 줍니다 —
   * 그 사이 빈 상자는 고장으로 읽힙니다.
   */
  const [summary, setSummary] = useState<
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'ready'; view: ReviewSummaryView }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/arcades/${arcade.id}/reviews`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? '리뷰를 불러오지 못했습니다');
      setReviews((data.reviews as ArcadeReview[]) ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : '리뷰를 불러오지 못했습니다');
    }
  }, [arcade.id]);

  useEffect(() => {
    // 다른 오락실을 열면 목록이 통째로 바뀝니다 — 3쪽을 보고 있었어도 1쪽부터.
    setPage(1);
    void load();
  }, [load]);

  // 목록이 바뀔 때마다(불러오기 · 등록 · 삭제) 요약을 다시 묻습니다. 서버는 리뷰가
  // 바뀌면 저장된 요약을 지우므로 이 요청이 새 요약을 만들거나, 아니면 저장된 것을 돌려줍니다.
  useEffect(() => {
    if (reviews.length < REVIEW_SUMMARY_MIN) {
      setSummary({ kind: 'idle' });
      return;
    }
    let alive = true;
    setSummary({ kind: 'loading' });
    void (async () => {
      try {
        const res = await fetch(`/api/arcades/${arcade.id}/reviews/summary`, { cache: 'no-store' });
        const data = (await res.json().catch(() => ({}))) as {
          summary?: ReviewSummaryView | null;
          error?: string;
        };
        if (!alive) return;
        if (!res.ok || !data.summary) {
          setSummary({ kind: 'error', message: data.error ?? '요약을 불러오지 못했습니다' });
          return;
        }
        setSummary({ kind: 'ready', view: data.summary });
      } catch {
        if (alive) setSummary({ kind: 'error', message: '네트워크 오류' });
      }
    })();
    return () => {
      alive = false;
    };
  }, [arcade.id, reviews]);

  // 오락실이나 플레이어가 바뀌면 내가 이미 쓴 리뷰를 폼에 채워 "수정" 이 되게 한다.
  const mine = playerId ? reviews.find((r) => r.playerId === playerId) : undefined;
  const totalPages = totalPagesOf(reviews.length, REVIEWS_PAGE_SIZE);
  const currentPage = Math.min(page, totalPages);
  const pageItems = reviews.slice(
    (currentPage - 1) * REVIEWS_PAGE_SIZE,
    currentPage * REVIEWS_PAGE_SIZE,
  );
  useEffect(() => {
    setRating(mine?.rating ?? 0);
    setBody(mine?.body ?? '');
    setError(null);
  }, [mine?.id, mine?.rating, mine?.body]);

  /** 고른 이모티콘을 본문 끝에 붙인다. 화면 maxLength 는 타이핑만 막으므로 여기서도 본다 */
  const addEmoticon = (token: string) => {
    setBody((v) => (v.length + token.length > 1000 ? v : v + token));
  };

  const save = async () => {
    if (!playerId || rating === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/arcades/${arcade.id}/reviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating, body: body.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? '저장에 실패했습니다');
        return;
      }
      setReviews(data.reviews as ArcadeReview[]);
      if (data.arcade) onArcadeChanged(data.arcade as Arcade);
    } catch {
      setError('네트워크 오류');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!playerId) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/arcades/${arcade.id}/reviews`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (res.ok) {
        setReviews(data.reviews as ArcadeReview[]);
        setRating(0);
        setBody('');
        if (data.arcade) onArcadeChanged(data.arcade as Arcade);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="section">
      <h3>
        리뷰
        {arcade.reviewCount > 0 && (
          <span className="rating-inline">
            <StarRating value={arcade.ratingAvg} />
            <strong>{arcade.ratingAvg?.toFixed(1)}</strong>
            <span className="muted small">{arcade.reviewCount}개</span>
          </span>
        )}
      </h3>

      {!playerId ? (
        <p className="muted small">
          <Link href="/login?next=%2Ffinder">로그인</Link>하면 리뷰를 남길 수 있습니다.
        </p>
      ) : (
        <div className="review-form">
          <div className="review-form-head">
            <StarRating value={rating === 0 ? null : rating} onChange={setRating} disabled={busy} />
            <span className="muted small">{mine ? '내 리뷰 수정' : '평점을 선택하세요'}</span>
          </div>
          <textarea
            rows={3}
            maxLength={1000}
            placeholder="기체 상태, 대기, 접근성 등 다음 사람에게 도움될 내용"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <div className="form-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy || rating === 0}
              onClick={save}
            >
              {mine ? '수정' : '등록'}
            </button>
            <EmoticonPicker disabled={busy} onPick={addEmoticon} />
            {mine && (
              <button
                type="button"
                className="btn btn-sm btn-danger"
                disabled={busy}
                onClick={remove}
              >
                삭제
              </button>
            )}
          </div>
          {error && <p className="warn">{error}</p>}
        </div>
      )}

      {/*
        AI 요약 — 리뷰가 다섯 개를 넘을 때만. 사람이 쓴 카드와 같은 모양이면 누가 쓴
        글인지 헷갈리므로 점선 상자에 'AI 요약' 딱지를 붙입니다(기종 추정과 같은 결).
        별점 평균은 서버가 SQL 로 낸 값이라 모델 답과 섞이지 않습니다.
      */}
      {reviews.length >= REVIEW_SUMMARY_MIN && summary.kind !== 'idle' && (
        <section className="review-summary" aria-live="polite">
          <p className="guess-head">
            <span className="guess-tag">AI 요약</span>
            {summary.kind === 'loading' && <span>리뷰 {reviews.length}개를 읽고 요약하는 중…</span>}
            {summary.kind === 'ready' && (
              <span>
                후기 {summary.view.reviewCount}개 기준
                {summary.view.ratingAvg !== null && ` · 평균 ★ ${summary.view.ratingAvg.toFixed(1)}`}
              </span>
            )}
            {summary.kind === 'error' && <span>요약 없음</span>}
          </p>
          {summary.kind === 'ready' &&
            (REVIEW_SUMMARY_KEYS.some(({ key }) => summary.view.summary[key]) ? (
              <dl>
                {REVIEW_SUMMARY_KEYS.filter(({ key }) => summary.view.summary[key]).map(({ key, label }) => (
                  <Fragment key={key}>
                    <dt>{label}</dt>
                    <dd>{summary.view.summary[key]}</dd>
                  </Fragment>
                ))}
              </dl>
            ) : (
              <p className="muted small">리뷰에서 세 칸에 넣을 만한 내용을 찾지 못했습니다.</p>
            ))}
          {summary.kind === 'error' && <p className="warn small">{summary.message}</p>}
        </section>
      )}

      {reviews.length === 0 ? (
        <p className="muted small">아직 리뷰가 없습니다.</p>
      ) : (
        <>
          <ul className="review-list">
            {pageItems.map((r) => (
              <li key={r.id} className={r.playerId === playerId ? 'is-mine' : ''}>
                <div className="review-head">
                  <StarRating value={r.rating} />
                  <strong>{r.nickname}</strong>
                  <span className="muted small">{timeAgo(r.updatedAt)}</span>
                </div>
                {r.body && (
                  <p className="review-body">
                    <EmoticonText text={r.body} />
                  </p>
                )}
              </li>
            ))}
          </ul>
          <Pagination
            page={currentPage}
            total={reviews.length}
            pageSize={REVIEWS_PAGE_SIZE}
            onChange={setPage}
          />
        </>
      )}
    </div>
  );
}
