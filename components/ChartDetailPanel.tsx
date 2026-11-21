'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import {
  UNDECIDED_CODE,
  UNIQUE_CODE,
  isSpecialChart,
  tierCodeOf,
  chartVideoSearchUrl,
  youtubeWatchUrl,
} from '@/lib/tier-types';
import type { ChartDetail, TierGame, TierGrade } from '@/lib/tier-types';
import { chartStepLabel } from '@/lib/chart-search-types';
import type { ChartSearchChart, SongCharts } from '@/lib/chart-search-types';
import ChartComments from './ChartComments';

interface Props {
  chart: ChartDetail;
  playerId: number | null;
  onChanged: (chart: ChartDetail) => void;
  onClose: () => void;
  /** 모드 표기(Single · MAXIMUM …)를 붙일 게임. 모르면 코드 그대로 쓴다 */
  game?: TierGame | null;
  /**
   * 오를 때마다 패널 제목으로 초점을 옮긴다 (C-3). 사용자가 칩을 눌러 연 채보가 도착했을
   * 때만 부모가 올린다 — 공유 주소로 처음부터 열린 패널은 초점을 빼앗지 않는다.
   */
  focusToken?: number;
  /** '이 곡의 다른 채보' 를 고르면 — 부모가 그 레벨로 건너가 패널을 바꾼다 */
  onPickChart?: (chart: ChartSearchChart) => void;
}

/**
 * 값에 가장 가까운 등급 anchor 의 인덱스.
 *
 * 정확히 두 anchor 의 중간이면 **0 에 가까운 쪽**(안쪽 등급)을 고른다. anchor 가
 * 좌우 대칭이므로 그래야 등급 띠도 좌우 대칭이 된다 — 펌프(anchor 0 · ±0.40)에서
 * '중' 은 -0.2 ~ 0.2 로 양 끝을 포함한다. sort_order 가 앞선 쪽을 집으면 동점이
 * 늘 '높은 등급' 으로 가서, 음수 쪽은 안쪽(-0.2 → 중)인데 양수 쪽은 바깥
 * (0.2 → 중상)으로 밀려 띠가 어긋난다.
 *
 * SQL 판정(recalc_chart_stats)도 같은 규칙이다 — 한쪽만 바꾸면 서열표에 배치된
 * 등급과 슬라이더가 보여주는 등급이 경계값에서 어긋난다.
 */
function nearestGradeIndex(grades: TierGrade[], value: number): number {
  let best = 0;
  for (let i = 1; i < grades.length; i++) {
    const gap = Math.abs(grades[i].anchor - value) - Math.abs(grades[best].anchor - value);
    const tie = Math.abs(gap) <= 1e-9;
    if (gap < -1e-9 || (tie && Math.abs(grades[i].anchor) < Math.abs(grades[best].anchor))) {
      best = i;
    }
  }
  return best;
}

/** 투표값을 가장 가까운 등급 anchor 로 버킷팅 (분포 히스토그램용) */
function bucketVotes(chart: ChartDetail): { label: string; count: number }[] {
  const buckets = chart.grades.map((g) => ({ label: g.label, count: 0 }));
  for (const v of chart.votes) buckets[nearestGradeIndex(chart.grades, v)].count += 1;
  return buckets;
}

function gradeLabelFor(chart: ChartDetail, value: number): string {
  return chart.grades[nearestGradeIndex(chart.grades, value)].label;
}

/** 투표로 계산된 등급 이름 (특수 패턴 여부와 무관) */
function voteGradeLabel(chart: ChartDetail): string {
  if (chart.tierCode === UNIQUE_CODE) return '개인차';
  if (chart.tierCode === UNDECIDED_CODE || chart.tierCode === null) return '미정';
  return chart.grades.find((g) => g.code === chart.tierCode)?.label ?? '미정';
}

/**
 * '현재 등급' 칸에 쓸 이름.
 *
 * 특수 패턴이면 **'특수패턴 / 투표등급'** 으로 둘 다 보여준다 — 서열표에서는
 * 특수패턴 칸에 있지만 투표로 계산된 등급도 그대로 살아 있어서, 한쪽만 보여주면
 * 정보가 사라진다. 칸을 가르는 규칙은 서버와 공유한다(tierCodeOf).
 */
function tierLabel(chart: ChartDetail): string {
  const grade = voteGradeLabel(chart);
  return isSpecialChart(chart, chart.settings) ? `특수패턴 / ${grade}` : grade;
}

/**
 * 숫자 뒤에 붙는 '으로' / '로' — 투표 버튼 문구(`0.40으로 투표하기`)에 쓴다.
 * 마지막 숫자를 읽는 소리로 가른다: 0(영) · 3(삼) · 6(육) 은 받침이 있어 '으로',
 * 나머지는 받침이 없거나 ㄹ 받침(1 일 · 7 칠 · 8 팔)이라 '로'.
 */
function withRo(num: string): string {
  return /[036]$/.test(num) ? `${num}으로` : `${num}로`;
}

/** 텍스트를 적는 칸인가 — 거기서 누른 Esc 는 패널을 닫지 않는다 (쓰던 평가를 잃지 않게) */
function isTyping(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA') return true;
  if (el.tagName !== 'INPUT') return false;
  const type = (el as HTMLInputElement).type;
  return type !== 'checkbox' && type !== 'radio' && type !== 'range' && type !== 'button';
}

export default function ChartDetailPanel({
  chart,
  playerId,
  onChanged,
  onClose,
  game = null,
  focusToken = 0,
  onPickChart,
}: Props) {
  const { settings } = chart;
  // 눈금은 tier_step(등급 간격)이 아니라 vote_step 을 따른다. 등급 판정은
  // anchor 최근접이라 눈금을 잘게 해도 판정 구간은 그대로다.
  const step = settings.voteStep;

  const [draft, setDraft] = useState<number>(chart.myVote ?? 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const titleId = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);

  /**
   * 칩을 눌러 열면 초점을 패널 제목으로 옮긴다 (UX 시험 2026-11-20 C-3). 예전에는 초점이
   * 칩에 남아 패널까지 Tab 을 18번 눌러야 했다. 제목은 tabIndex=-1 이라 Tab 순서에는
   * 끼지 않고, 화면 낭독기는 제목부터 읽는다.
   */
  useEffect(() => {
    if (focusToken > 0) titleRef.current?.focus();
  }, [focusToken]);

  /** 링크 복사 결과 — 몇 초 뒤 걷는다 */
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);
  useEffect(() => {
    if (copied === null) return;
    const t = window.setTimeout(() => setCopied(null), 3000);
    return () => window.clearTimeout(t);
  }, [copied]);

  /**
   * 지금 주소를 복사한다. 부모(TierBoardView)가 패널을 열 때 주소에 `&chart=` 를 넣어 두므로
   * 주소가 곧 이 채보의 공유 주소다 (C-1). 복사를 막은 브라우저면 주소창을 쓰라고 말한다.
   */
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied('ok');
    } catch {
      setCopied('fail');
    }
  };

  /** 같은 곡의 다른 채보 (T-1). 채보를 바꾸면 다시 읽는다 */
  const [song, setSong] = useState<SongCharts | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`/api/charts/${chart.id}/siblings`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (live) setSong((d as SongCharts | null) ?? null);
      })
      .catch(() => undefined); // 못 읽어도 그 줄만 빠진다
    return () => {
      live = false;
    };
  }, [chart.id]);
  const siblings =
    song && song.charts.some((c) => c.id === chart.id)
      ? song.charts.filter((c) => c.id !== chart.id)
      : [];

  // 로그인하고 돌아오면 보던 표와 채보로 (주소 그대로 — C-1 · C-4). 이 패널은 채보를
  // 받아 온 뒤에만 그려져 서버 렌더가 없다 — window 를 바로 읽어도 하이드레이션과 무관하다.
  const loginNext =
    typeof window === 'undefined' ? '/tier' : window.location.pathname + window.location.search;

  // 다른 채보를 고르면 슬라이더를 그 채보의 내 투표값으로 되돌린다.
  useEffect(() => {
    setDraft(chart.myVote ?? 0);
    setError(null);
  }, [chart.id, chart.myVote]);

  /**
   * 상태를 바꾸는 요청 하나. **켜는 것은 PUT, 끄는 것은 DELETE** 입니다
   * (GUIDELINES §4-1 — 토글은 재시도·낡은 상태에 깨집니다).
   * DELETE 에는 본문을 싣지 않습니다 — 중간 장비가 버리는 경우가 있습니다.
   */
  const send = async (url: string, method: 'PUT' | 'DELETE', body?: unknown) => {
    if (!playerId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method,
        ...(body === undefined
          ? {}
          : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? '저장하지 못했어요. 다시 시도해 주세요');
        return;
      }
      onChanged(data.chart as ChartDetail);
    } catch {
      setError('연결이 잠깐 끊겼어요. 다시 시도해 주세요');
    } finally {
      setBusy(false);
    }
  };

  const buckets = bucketVotes(chart);
  const maxCount = Math.max(1, ...buckets.map((b) => b.count));
  // DB 값을 그대로 href 에 꽂지 않습니다 — 유튜브 주소일 때만 링크가 됩니다.
  const videoUrl = youtubeWatchUrl(chart.videoUrl);
  // 등록된 영상이 없으면 검색으로 보냅니다 — 빈 자리를 두는 것보다 낫습니다.
  const searchUrl = chartVideoSearchUrl(chart);
  // 안내문에 넣을 "몇 표 · 몇 명 더" (DESIGN-GUIDE §2-8). '미정' 은 투표 수가
  // min_votes 미만일 때라(recalc_chart_stats) 남은 표는 늘 1 이상이다.
  const votesLeft = Math.max(1, settings.minVotes - chart.voteCount);
  const specialLeft = Math.max(0, settings.specialMin - chart.specialCount);
  const draftLabel = draft.toFixed(2);

  return (
    <section
      className="detail"
      aria-labelledby={titleId}
      onKeyDown={(e) => {
        // Esc 로 닫는다 (C-3). 글을 쓰는 칸에서는 쓰던 것을 잃지 않게 닫지 않고, 안쪽의 다른
        // 부품(이모티콘 고르기 등)이 이미 Esc 를 썼으면(defaultPrevented) 그쪽에 맡긴다.
        if (e.key !== 'Escape' || e.defaultPrevented || isTyping(e.target)) return;
        // 이모티콘 고르기는 document 에서 Esc 를 받아 스스로 닫는다 — 그 안에서 누른 Esc 로
        // 패널까지 닫히지 않게, 펼쳐진 고르기 안이면 그쪽에 맡긴다.
        if (
          e.target instanceof Element &&
          e.target.closest('.emoticon-picker:has([aria-expanded="true"])')
        ) {
          return;
        }
        e.preventDefault();
        onClose();
      }}
    >
      <div className="detail-head">
        <div>
          <h2 id={titleId} ref={titleRef} tabIndex={-1}>
            {chart.title}
          </h2>
          <p className="muted small">
            {/* modeLabel 이 null 이면 난이도 미표기라 레벨만 붙인다 (migrate-047).
                difficultyLabel 은 난이도 축이 있는 게임에서만 있다 (migrate-059). */}
            {chart.artist ?? '아티스트 모름'} · {chart.machineName}{' '}
            {chart.modeLabel === null ? '' : `${chart.modeLabel} `}
            {chart.difficultyLabel === null ? '' : `${chart.difficultyLabel} `}
            {/* 난이도 미상이면 숫자가 없다 (migrate-059) */}
            Lv.{chart.level ?? '?'}
          </p>
        </div>
        <div className="detail-head-actions">
          <button type="button" className="btn btn-sm" onClick={() => void copyLink()}>
            링크 복사
          </button>
          <button type="button" className="btn btn-sm" onClick={onClose}>
            닫기
          </button>
        </div>
      </div>
      <p className="chart-copy-note small" role="status">
        {copied === 'ok' && '링크를 복사했어요. 붙여 넣으면 이 채보가 열려요'}
        {copied === 'fail' && '복사하지 못했어요. 주소창의 주소를 복사해 주세요'}
      </p>

      {siblings.length > 0 && onPickChart && (
        <nav className="chart-siblings" aria-label="이 곡의 다른 채보">
          <span className="muted small">이 곡의 다른 채보</span>
          <div className="chart-siblings-list">
            {siblings.map((c) => (
              <button
                key={c.id}
                type="button"
                className="btn btn-sm"
                onClick={() => onPickChart(c)}
              >
                {chartStepLabel(c, game)}
              </button>
            ))}
          </div>
        </nav>
      )}

      {/*
        채보 영상. 숫자(등급·평균·투표 수)보다 **위**에 둡니다 — 처음 보는 채보에
        투표하려면 먼저 그 채보가 어떻게 생겼는지 봐야 하고, 숫자는 그 다음입니다.
        새 탭으로 엽니다: 여기서 나가면 보던 서열표와 투표 슬라이더를 잃습니다.
      */}
      <a
        className={videoUrl ? 'chart-video' : 'chart-video is-search'}
        href={videoUrl ?? searchUrl}
        target="_blank"
        rel="noopener noreferrer nofollow"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path
            d="M12 3c-4 0-6.7.3-6.7.3A2.6 2.6 0 0 0 3 5.6S2.7 7.6 2.7 12s.3 6.4.3 6.4a2.6 2.6 0 0 0 2.3 2.3s2.7.3 6.7.3 6.7-.3 6.7-.3a2.6 2.6 0 0 0 2.3-2.3s.3-2 .3-6.4-.3-6.4-.3-6.4a2.6 2.6 0 0 0-2.3-2.3S16 3 12 3Z"
            fill="currentColor"
          />
          <path d="M10 8.5v7l6-3.5-6-3.5Z" fill="var(--panel)" />
        </svg>
        <span>{videoUrl ? '채보 영상 보기' : '채보 영상 찾기'}</span>
        <span className="muted small">
          {videoUrl ? 'YouTube · 새 탭' : 'YouTube 검색 · 새 탭'}
        </span>
      </a>

      <div className="stat-grid">
        <div className="stat">
          <span>현재 등급</span>
          <strong className={`tier-mark tier-${tierCodeOf(chart, chart.settings)}`}>
            {tierLabel(chart)}
          </strong>
        </div>
        <div className="stat">
          <span>평균 투표</span>
          <strong>{chart.avgVote === null ? '—' : chart.avgVote.toFixed(2)}</strong>
        </div>
        <div className="stat">
          <span>투표 수</span>
          <strong>{chart.voteCount}</strong>
        </div>
        <div className="stat" title="1에 가까울수록 투표가 한데 모였어요">
          <span>의견 일치도</span>
          <strong>{chart.convergence === null ? '—' : chart.convergence.toFixed(2)}</strong>
        </div>
      </div>

      {chart.tierCode === 'undecided' && (
        <p className="hint">
          투표가 {votesLeft}표 더 모이면 등급이 정해져요 (지금 {chart.voteCount}표).
        </p>
      )}
      {chart.tierCode === 'unique' && (
        <p className="hint">
          의견이 크게 갈리는 채보예요. 의견 일치도가 {settings.minConvergence}보다 낮으면
          &lsquo;개인차&rsquo; 칸에 놓여요.
        </p>
      )}

      <div className="section">
        <h3>투표 분포</h3>
        {chart.votes.length === 0 ? (
          <p className="muted small">아직 투표가 없어요. 클리어했다면 아래에서 첫 투표를 남겨 주세요.</p>
        ) : (
          <div className="histogram">
            {buckets.map((b) => (
              <div key={b.label} className="hist-col">
                <div className="hist-bar-wrap">
                  <div
                    className="hist-bar"
                    style={{ height: `${(b.count / maxCount) * 100}%` }}
                    title={`${b.label} ${b.count}표`}
                  />
                </div>
                <span className="hist-count">{b.count || ''}</span>
                <span className="hist-label">{b.label}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="section">
        <h3>내 기록</h3>

        {!playerId ? (
          <p className="muted small">
            <Link href={`/login?next=${encodeURIComponent(loginNext)}`}>로그인</Link>하면 클리어 기록과 체감 난이도를 남길 수
            있어요.
          </p>
        ) : (
          <>
            <label className="check">
              <input
                type="checkbox"
                checked={chart.myClear}
                disabled={busy}
                onChange={(e) =>
                  send(`/api/charts/${chart.id}/clear`, e.target.checked ? 'PUT' : 'DELETE')
                }
              />
              <span>이 채보를 클리어했어요</span>
            </label>

            {!chart.myClear ? (
              <p className="hint">
                클리어한 채보만 체감 난이도에 투표할 수 있어요. 나중에 체크를 풀면 남긴 투표도
                함께 지워져요.
              </p>
            ) : (
              <div className="vote-box">
                <div className="vote-head">
                  <span className="muted small">체감 난이도</span>
                  <strong>
                    {draftLabel}
                    <em className="vote-grade">{gradeLabelFor(chart, draft)}</em>
                  </strong>
                </div>

                <input
                  type="range"
                  min={settings.voteMin}
                  max={settings.voteMax}
                  step={step}
                  value={draft}
                  disabled={busy}
                  onChange={(e) => setDraft(Number(e.target.value))}
                />
                <div className="vote-scale">
                  <span>쉬움 {settings.voteMin.toFixed(1)}</span>
                  <span>{settings.voteMax.toFixed(1)} 어려움</span>
                </div>

                <div className="form-actions vote-actions">
                  {/* 버튼에 고른 값을 담는다 — 누르기 전에 무엇이 저장될지 보인다 (DESIGN-GUIDE §1-3).
                      지금 투표와 같은 값이면 버튼이 꺼지므로 그때는 상태를 말한다. */}
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={busy || draft === chart.myVote}
                    onClick={() => send(`/api/charts/${chart.id}/vote`, 'PUT', { value: draft })}
                  >
                    {chart.myVote === null
                      ? `${withRo(draftLabel)} 투표하기`
                      : draft === chart.myVote
                        ? `${draftLabel}에 투표했어요`
                        : `${withRo(draftLabel)} 바꾸기`}
                  </button>
                  {/* 다시 투표할 수 있는 일이라 주 버튼과 같은 무게로 두지 않고 글자 링크로 낮춘다 */}
                  {chart.myVote !== null && (
                    <button
                      type="button"
                      className="btn-link"
                      disabled={busy}
                      onClick={() => send(`/api/charts/${chart.id}/vote`, 'DELETE')}
                    >
                      내 투표 지우기
                    </button>
                  )}
                </div>
              </div>
            )}
          </>
        )}

        {error && <p className="warn">{error}</p>}
      </div>

      <div className="section">
        <h3>특수 패턴</h3>
        {!playerId ? (
          <p className="muted small">로그인하면 특수 패턴으로 표시할 수 있어요.</p>
        ) : (
          <>
            <label className="check">
              <input
                type="checkbox"
                checked={chart.mySpecial}
                disabled={busy}
                onChange={(e) =>
                  send(`/api/charts/${chart.id}/special`, e.target.checked ? 'PUT' : 'DELETE')
                }
              />
              <span>특수 패턴 채보예요</span>
            </label>
            {/* 두 문장까지 (DESIGN-GUIDE §1-1). 몇 명이 더 표시하면 옮겨지는지를 숫자로 말한다. */}
            <p className="hint">
              기믹·연출로 난이도가 정해지는 채보라면 표시해 주세요.{' '}
              {specialLeft > 0 ? (
                <>
                  <strong>{specialLeft}명</strong>이 더 표시하면 &lsquo;특수패턴&rsquo; 칸으로
                  옮겨지고, 투표 등급은 그대로 남아요.
                </>
              ) : (
                <>
                  <strong>{chart.specialCount}명</strong>이 표시해 &lsquo;특수패턴&rsquo; 칸에
                  있고, {settings.specialMin}명 아래로 줄면 원래 등급으로 돌아가요.
                </>
              )}
            </p>
          </>
        )}
      </div>

      <ChartComments chart={chart} playerId={playerId} onChanged={onChanged} />
    </section>
  );
}
