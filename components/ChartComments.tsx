'use client';

import Link from 'next/link';

import { useEffect, useState } from 'react';
import { CHART_COMMENTS_PAGE_SIZE, chartTagsFor, timeAgo } from '@/lib/community-types';
import { totalPagesOf } from '@/lib/board-types';
import EmoticonPicker from './EmoticonPicker';
import EmoticonText from './EmoticonText';
import { useBlockedIds } from '@/lib/use-blocks';
import { useIsAdmin } from '@/lib/use-session';
import Pagination from './Pagination';
import ReportMenu from './ReportMenu';
import ScrollStrip from './ScrollStrip';
import type { ChartDetail } from '@/lib/tier-types';

interface Props {
  chart: ChartDetail;
  playerId: number | null;
  onChanged: (chart: ChartDetail) => void;
}

const MAX_TAGS = 4;

/**
 * 채보 평가.
 *
 * 투표(슬라이더)가 "얼마나 어렵냐" 라면 이쪽은 "왜 어렵냐" 입니다.
 * 태그를 고정 목록으로 두는 이유는 lib/community-types.ts CHART_TAGS 주석 참고.
 */
export default function ChartComments({ chart, playerId, onChanged }: Props) {
  const mine = playerId ? chart.comments.find((c) => c.playerId === playerId) : undefined;

  // 고를 수 있는 태그는 게임마다 다르다 — 펌프는 발판(떨기·틀기…), 사볼은 손(지력·건반…).
  const tagOptions = chartTagsFor(chart.machineId);

  const [body, setBody] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  /** 1-based. 다른 채보를 열면 목록이 통째로 바뀌므로 chart.id 가 바뀔 때 1쪽으로 */
  const [page, setPage] = useState(1);
  useEffect(() => {
    setPage(1);
  }, [chart.id]);
  // 내가 차단한 사람의 평가는 가린다 (lib/use-blocks.ts)
  const blockedIds = useBlockedIds();
  const isAdmin = useIsAdmin();
  const visible = chart.comments.filter((c) => !blockedIds.has(c.playerId));
  const hiddenCount = chart.comments.length - visible.length;
  const totalPages = totalPagesOf(visible.length, CHART_COMMENTS_PAGE_SIZE);
  const currentPage = Math.min(page, totalPages);
  const pageItems = visible.slice(
    (currentPage - 1) * CHART_COMMENTS_PAGE_SIZE,
    currentPage * CHART_COMMENTS_PAGE_SIZE,
  );

  // 채보를 바꾸거나 내 평가가 바뀌면 폼을 그 상태로 되돌린다.
  useEffect(() => {
    setBody(mine?.body ?? '');
    setTags(mine?.tags ?? []);
    setEditing(false);
    setError(null);
  }, [chart.id, mine?.id, mine?.updatedAt]);

  const toggleTag = (tag: string) =>
    setTags((prev) =>
      prev.includes(tag)
        ? prev.filter((t) => t !== tag)
        : prev.length >= MAX_TAGS
          ? prev
          : [...prev, tag],
    );

  /** 고른 이모티콘을 본문 끝에 붙인다. 화면 maxLength 는 타이핑만 막으므로 여기서도 본다 */
  const addEmoticon = (token: string) => {
    setBody((v) => (v.length + token.length > 1000 ? v : v + token));
  };

  const save = async () => {
    if (!playerId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/charts/${chart.id}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: body.trim(), tags }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.details?.[0] ?? data.error ?? '평가를 저장하지 못했어요. 다시 시도해 주세요');
        return;
      }
      onChanged(data.chart as ChartDetail);
      setEditing(false);
    } catch {
      setError('연결이 잠깐 끊겼어요. 다시 시도해 주세요');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!playerId) return;
    // 되돌릴 수 없는 일은 한 번 묻고, 실패하면 이유를 보여 줍니다 (예전에는 조용히 끝났습니다)
    if (!window.confirm('내 평가를 지울까요? 되돌릴 수 없어요.')) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/charts/${chart.id}/comments`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? '평가를 지우지 못했어요. 다시 시도해 주세요');
        return;
      }
      onChanged(data.chart as ChartDetail);
      setBody('');
      setTags([]);
    } catch {
      setError('연결이 잠깐 끊겼어요. 다시 시도해 주세요');
    } finally {
      setBusy(false);
    }
  };

  const showForm = !mine || editing;

  return (
    <div className="section">
      <h3>
        채보 평가 <span className="muted small">{chart.comments.length}개</span>
      </h3>

      {!playerId ? (
        <p className="muted small">
          <Link href="/login?next=%2Ftier">로그인</Link>하면 평가를 남길 수 있어요.
        </p>
      ) : showForm ? (
        <div className="comment-form">
          {/*
            게임마다 태그 수가 달라(펌프 12 · EZ2 12 · 공통 8) 좁은 상세 패널에서
            두 줄·세 줄로 접히면 그 아래 입력란이 그만큼 오르내립니다. 커뮤니티
            게임 탭과 같은 부품으로 한 줄에 두고 옆으로 밉니다 (ScrollStrip).

            revealKey 는 **주지 않습니다.** 태그는 여러 개를 켜는 줄이라, 하나 켤
            때마다 첫 번째 켜진 칩으로 끌려가 방금 누른 자리를 잃습니다
            (ScrollStrip 머리말의 경고 — 사이드바 기종 필터와 같은 이유).
          */}
          <ScrollStrip className="tag-row" remeasureKey={tagOptions.length}>
            {tagOptions.map((t) => (
              <button
                key={t}
                type="button"
                className={`chip ${tags.includes(t) ? 'is-on' : ''}`}
                disabled={busy || (!tags.includes(t) && tags.length >= MAX_TAGS)}
                onClick={() => toggleTag(t)}
              >
                {t}
              </button>
            ))}
          </ScrollStrip>
          <textarea
            rows={3}
            maxLength={1000}
            placeholder="어디가 어떻게 어려웠나요? (예: 후반 폭타에서 체력이 빠져요)"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <div className="form-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy || body.trim().length < 2}
              onClick={save}
            >
              {mine ? '고친 평가 저장하기' : '평가 남기기'}
            </button>
            <EmoticonPicker disabled={busy} onPick={addEmoticon} />
            {/* 취소는 주 버튼과 같은 무게로 두지 않는다 — 글자 링크 (DESIGN-GUIDE §1-2) */}
            {mine && (
              <button
                type="button"
                className="btn-link"
                disabled={busy}
                onClick={() => setEditing(false)}
              >
                취소
              </button>
            )}
          </div>
          {error && <p className="warn">{error}</p>}
          <p className="hint">
            클리어하지 않았어도 막힌 지점을 남겨 주세요. 목록에는 클리어했는지가 함께 보여요.
          </p>
        </div>
      ) : (
        /* 내 평가가 있을 때의 단추 줄. 폼(.comment-form)과 같은 12px 로 목록과 떼어 둡니다 —
           여백이 없으면 삭제 단추가 첫 평가 카드의 테두리에 붙어 한 덩이로 읽힙니다. */
        <div className="form-actions comment-mine-actions">
          <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>
            내 평가 수정
          </button>
          <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={remove}>
            지우기
          </button>
        </div>
      )}

      {hiddenCount > 0 && (
        <p className="muted small blocked-note">차단한 사용자의 평가 {hiddenCount}개를 가렸어요.</p>
      )}
      {visible.length === 0 ? (
        chart.comments.length === 0 && (
          <p className="muted small">아직 평가가 없어요. 어디가 어려웠는지 첫 평가를 남겨 주세요.</p>
        )
      ) : (
        <>
          <ul className="comment-list">
            {pageItems.map((c) => (
              <li key={c.id} className={c.playerId === playerId ? 'is-mine' : ''}>
                <div className="comment-head">
                  <strong>{c.nickname}</strong>
                  {c.cleared ? (
                    <span className="tag tag-clear">클리어</span>
                  ) : (
                    <span className="tag tag-noclear">미클리어</span>
                  )}
                  <span className="muted small">{timeAgo(c.updatedAt)}</span>
                  {!isAdmin && (
                    <ReportMenu
                      targetType="chart_comment"
                      targetId={c.id}
                      author={{ playerId: c.playerId, nickname: c.nickname }}
                    />
                  )}
                </div>
                {c.tags.length > 0 && (
                  <div className="tag-row">
                    {c.tags.map((t) => (
                      <span key={t} className="tag">
                        {t}
                      </span>
                    ))}
                  </div>
                )}
                <p className="comment-body">
                  <EmoticonText text={c.body} />
                </p>
              </li>
            ))}
          </ul>
          <Pagination
            page={currentPage}
            total={visible.length}
            pageSize={CHART_COMMENTS_PAGE_SIZE}
            onChange={setPage}
          />
        </>
      )}
    </div>
  );
}
