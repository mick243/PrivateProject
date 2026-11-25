'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { timeAgo } from '@/lib/community-types';
import {
  isIndefinite,
  REPORT_REASON_LABEL,
  REPORT_STATUS_LABEL,
  REPORT_TARGET_LABEL,
  SUSPEND_OPTIONS,
  suspendConfirmText,
  suspendLabel,
  unsuspendConfirmText,
  type AdminPlayerRow,
  type GuessRow,
  type ReportGroup,
  type ReportReason,
  type ReportStatus,
} from '@/lib/moderation-types';
import { useSession } from '@/lib/use-session';
import { ARCADE_INFO_KIND_SHORT, INFO_HOURS_MAX, type ArcadeInfoReportRow } from '@/lib/arcade-info-report-types';

/**
 * 관리 화면 (`/admin`). **관리자만.** — 신고함 · 정보 고침 · 계정 · AI 기종 추정 네 칸.
 * 정보 고침(2026-11-25 · migrate-087)은 이용자가 상세의 "정보가 달라요" 로 보낸 영업시간 · 문 닫음 · 옮김입니다.
 *
 * 2026-11-20 전에는 관리자 화면이 이모티콘 관리 하나뿐이라, 신고는 메일로 받고 계정 정지 · AI 추정
 * 승인은 DB 를 직접 고쳐야 했습니다. 이 화면이 부르는 API 는 전부 requireAdmin 을 지납니다
 * (app/api/admin/*). 관리자가 아니면 /admin/emoticons 와 같이 "없는 주소" 화면을 보여 줍니다.
 *
 * 지우기 · 정지 · 정지 풀기는 한 번 묻습니다. 정지는 사유가 있어야 하고(서버도 막습니다),
 * 정지 풀기는 정지 단추가 있던 자리가 아니라 사유 줄 끝의 글자 링크입니다 — 2026-11-20 UX 시험
 * Ad-2 · Ad-3 에서 사유 없이 정지되고, 같은 자리에 나타난 '정지 풀기'를 한 번 더 눌러 바로 풀렸습니다.
 * 기각 · 추정 버리기는 다시 할 수 있어 묻지 않습니다.
 */

type Tab = 'reports' | 'info' | 'players' | 'guesses';
const TAB_LABEL: Record<Tab, string> = {
  reports: '신고함',
  info: '정보 고침',
  players: '계정',
  guesses: 'AI 기종 추정',
};

type Load<T> = { kind: 'loading' } | { kind: 'failed'; message: string } | { kind: 'ready'; data: T };

async function errorOf(res: Response, fallback: string): Promise<string> {
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return data.error ?? fallback;
}

async function getJson<T>(url: string): Promise<Load<T>> {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return { kind: 'failed', message: await errorOf(res, '목록을 불러오지 못했어요. 다시 시도해 주세요') };
    return { kind: 'ready', data: (await res.json()) as T };
  } catch {
    return { kind: 'failed', message: OFFLINE };
  }
}

const OFFLINE = '연결이 잠깐 끊겼어요. 다시 시도해 주세요';
const NOT_DONE = '처리하지 못했어요. 다시 시도해 주세요';

/** 요청 하나 — 성공하면 응답 본문까지 */
async function sendJson<T = unknown>(
  url: string,
  init: RequestInit,
): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
  try {
    const res = await fetch(url, {
      ...init,
      headers: init.body ? { 'content-type': 'application/json' } : undefined,
    });
    if (!res.ok) return { ok: false, message: await errorOf(res, NOT_DONE) };
    return { ok: true, data: (await res.json().catch(() => ({}))) as T };
  } catch {
    return { ok: false, message: OFFLINE };
  }
}

/** 요청 하나 — 실패하면 문구, 성공하면 null */
async function send(url: string, init: RequestInit): Promise<string | null> {
  const res = await sendJson(url, init);
  return res.ok ? null : res.message;
}

function NotFound() {
  return (
    <main className="login-page">
      <section className="login-card">
        <h1>이런 주소는 없어요</h1>
        <p className="muted small">주소가 바뀌었거나 잘못 적힌 것 같아요.</p>
        <div className="form-actions">
          <Link className="btn btn-primary btn-sm" href="/">
            오락실 파인더
          </Link>
        </div>
      </section>
    </main>
  );
}

// ─── 신고함 ──────────────────────────────────────────────────

function ReportsPanel() {
  const [status, setStatus] = useState<ReportStatus>('open');
  const [list, setList] = useState<Load<{ groups: ReportGroup[] }>>({ kind: 'loading' });
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setList({ kind: 'loading' });
    setList(await getJson(`/api/admin/reports?status=${status}`));
  }, [status]);
  useEffect(() => {
    void load();
  }, [load]);

  const resolve = async (g: ReportGroup, action: 'delete' | 'dismiss') => {
    const what = REPORT_TARGET_LABEL[g.targetType];
    if (action === 'delete' && !window.confirm(`이 ${what}을(를) 지울까요? 되돌릴 수 없어요.`)) return;
    const key = `${g.targetType}:${g.targetId}`;
    setBusyKey(key);
    setError(null);
    const err = await send('/api/admin/reports', {
      method: 'PUT',
      body: JSON.stringify({ targetType: g.targetType, targetId: g.targetId, action }),
    });
    setBusyKey(null);
    if (err) {
      setError(err);
      return;
    }
    // 처리한 줄은 처리 전 목록에서 뺀다 (다시 불러오지 않음 — 다른 줄이 튀지 않게)
    setList((prev) =>
      prev.kind === 'ready'
        ? { kind: 'ready', data: { groups: prev.data.groups.filter((x) => `${x.targetType}:${x.targetId}` !== key) } }
        : prev,
    );
  };

  return (
    <section aria-label="신고함">
      <div className="mod-tabs" role="tablist" aria-label="신고 상태">
        {(Object.keys(REPORT_STATUS_LABEL) as ReportStatus[]).map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={status === s}
            className={status === s ? 'btn btn-sm btn-on' : 'btn btn-sm'}
            onClick={() => setStatus(s)}
          >
            {REPORT_STATUS_LABEL[s]}
          </button>
        ))}
      </div>
      {error && <p className="warn small" role="alert">{error}</p>}
      {list.kind === 'loading' && <p className="muted small">불러오는 중…</p>}
      {list.kind === 'failed' && <p className="warn small">{list.message}</p>}
      {list.kind === 'ready' &&
        (list.data.groups.length === 0 ? (
          <p className="muted small">{status === 'open' ? '처리할 신고가 없습니다.' : '없습니다.'}</p>
        ) : (
          <ul className="mod-list">
            {list.data.groups.map((g) => {
              const key = `${g.targetType}:${g.targetId}`;
              return (
                <li key={key} className="mod-card">
                  <div className="mod-card-head">
                    <span className="admin-badge">{REPORT_TARGET_LABEL[g.targetType]}</span>
                    <strong>신고 {g.count}건</strong>
                    <span className="muted small">
                      {(Object.entries(g.reasons) as [ReportReason, number][])
                        .map(([r, n]) => `${REPORT_REASON_LABEL[r]} ${n}`)
                        .join(' · ')}
                    </span>
                    <span className="muted small">마지막 {timeAgo(g.lastAt)}</span>
                    {status === 'open' && !g.targetExists && <span className="admin-badge is-gone">이미 지워짐</span>}
                  </div>
                  <p className="mod-card-excerpt">
                    {g.author ? <strong>{g.author.nickname}</strong> : <span className="muted">(탈퇴한 사용자)</span>}{' '}
                    {g.excerpt ?? <span className="muted">(내용 없음)</span>}
                  </p>
                  {g.details.length > 0 && (
                    <ul className="muted small">
                      {g.details.map((d, i) => (
                        <li key={i}>
                          {d.nickname}: {d.detail}
                        </li>
                      ))}
                    </ul>
                  )}
                  {status === 'open' && (
                    <div className="form-actions">
                      {g.href && (
                        <a className="btn btn-sm" href={g.href} target="_blank" rel="noopener noreferrer">
                          원문 보기
                        </a>
                      )}
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        disabled={busyKey === key}
                        onClick={() => void resolve(g, 'delete')}
                      >
                        {g.targetExists ? '지우기' : '처리 완료'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={busyKey === key}
                        onClick={() => void resolve(g, 'dismiss')}
                      >
                        기각
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        ))}
    </section>
  );
}

// ─── 계정 ────────────────────────────────────────────────────

/** 정지 끝 시각 — `11월 27일 18:31까지` */
function untilLabel(until: string): string {
  if (isIndefinite(until)) return '무기한 정지';
  const d = new Date(until);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `정지 · ${d.getMonth() + 1}월 ${d.getDate()}일 ${hh}:${mm}까지`;
}

function PlayersPanel() {
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [list, setList] = useState<Load<{ players: AdminPlayerRow[] }>>({ kind: 'loading' });
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 처리 결과 안내 — `○○ 님을 7일 정지했어요` · `정지를 풀었어요` */
  const [done, setDone] = useState<string | null>(null);
  /** 사유를 비운 채 누른 줄 — 그 칸에 안내를 붙인다 */
  const [reasonMissing, setReasonMissing] = useState<number | null>(null);
  /** 줄마다 고른 정지 기간 · 사유 */
  const [draft, setDraft] = useState<Record<number, { days: string; reason: string }>>({});

  const load = useCallback(async () => {
    setList({ kind: 'loading' });
    setList(await getJson(`/api/admin/players${query ? `?q=${encodeURIComponent(query)}` : ''}`));
  }, [query]);
  useEffect(() => {
    void load();
  }, [load]);

  const draftOf = (id: number) => draft[id] ?? { days: '7', reason: '' };

  /** 한 줄만 고쳐 끼운다 — 목록을 다시 불러오면 정지를 푼 계정이 말없이 빠지기 때문(Ad-3) */
  const patchRow = (id: number, patch: Partial<AdminPlayerRow>) =>
    setList((prev) =>
      prev.kind === 'ready'
        ? { kind: 'ready', data: { players: prev.data.players.map((x) => (x.id === id ? { ...x, ...patch } : x)) } }
        : prev,
    );

  const suspend = async (p: AdminPlayerRow) => {
    const d = draftOf(p.id);
    const days = d.days === 'null' ? null : Number(d.days);
    const reason = d.reason.trim();
    setDone(null);
    if (!reason) {
      setReasonMissing(p.id);
      document.getElementById(`suspend-reason-${p.id}`)?.focus();
      return;
    }
    setReasonMissing(null);
    if (!window.confirm(suspendConfirmText(p.nickname, days, reason))) return;
    setBusyId(p.id);
    setError(null);
    const res = await sendJson<{ until: string }>(`/api/admin/players/${p.id}/suspension`, {
      method: 'PUT',
      body: JSON.stringify({ days, reason }),
    });
    setBusyId(null);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    patchRow(p.id, { suspendedUntil: res.data.until, suspendedReason: reason });
    setDraft((prev) => ({ ...prev, [p.id]: { days: '7', reason: '' } }));
    setDone(`${p.nickname} 님을 ${suspendLabel(days)} 정지했어요.`);
  };

  const unsuspend = async (p: AdminPlayerRow) => {
    setDone(null);
    if (!window.confirm(unsuspendConfirmText(p.nickname))) return;
    setBusyId(p.id);
    setError(null);
    const res = await sendJson(`/api/admin/players/${p.id}/suspension`, { method: 'DELETE' });
    setBusyId(null);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    patchRow(p.id, { suspendedUntil: null, suspendedReason: null });
    // 기본 목록(신고 · 정지 중)은 다음에 불러올 때 이 계정이 빠질 수 있어 미리 말해 둔다
    setDone(
      !query && p.openReports === 0
        ? `${p.nickname} 님의 정지를 풀었어요. 처리 전 신고가 없어서 다음에 열면 목록에서 빠져요.`
        : `${p.nickname} 님의 정지를 풀었어요.`,
    );
  };

  return (
    <section aria-label="계정">
      <form
        className="admin-toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          setDone(null);
          setQuery(q.trim());
        }}
      >
        <input
          className="admin-search"
          type="search"
          value={q}
          placeholder="닉네임 또는 번호"
          aria-label="계정 찾기"
          onChange={(e) => setQ(e.target.value)}
        />
        <button type="submit" className="btn btn-sm">
          찾기
        </button>
      </form>
      <p className="muted small">
        {query ? `'${query}'(으)로 찾은 계정이에요.` : '처리 전 신고가 들어온 사람과 정지 중인 사람이에요. 다른 계정은 위에서 찾아 주세요.'}
      </p>
      {done && (
        <p className="notice small" role="status">
          {done}
        </p>
      )}
      {error && <p className="warn small" role="alert">{error}</p>}
      {list.kind === 'loading' && <p className="muted small">불러오는 중…</p>}
      {list.kind === 'failed' && <p className="warn small">{list.message}</p>}
      {list.kind === 'ready' &&
        (list.data.players.length === 0 ? (
          <p className="muted small">{query ? `'${query}'에 맞는 계정이 없어요. 닉네임을 다시 확인해 주세요.` : '손볼 계정이 없어요.'}</p>
        ) : (
          <ul className="mod-list">
            {list.data.players.map((p) => {
              const d = draftOf(p.id);
              const days = d.days === 'null' ? null : Number(d.days);
              const missing = reasonMissing === p.id;
              return (
                <li key={p.id} className="mod-card">
                  <div className="mod-card-head">
                    <strong>{p.nickname}</strong>
                    <span className="muted small">#{p.id} · 가입 {timeAgo(p.createdAt)}</span>
                    {p.isAdmin && <span className="admin-badge">관리자</span>}
                    {p.openReports > 0 && <span className="admin-badge is-gone">처리 전 신고 {p.openReports}</span>}
                    {p.suspendedUntil && <span className="admin-badge is-gone">{untilLabel(p.suspendedUntil)}</span>}
                  </div>
                  <p className="muted small">
                    글 {p.posts} · 댓글 {p.comments} · 리뷰 {p.reviews}
                  </p>
                  {p.suspendedUntil ? (
                    // 정지 중 — 정지 단추가 있던 자리에 풀기 단추를 두지 않는다(Ad-3).
                    // 사유 줄 끝의 글자 링크 + 확인창으로 낮춘다.
                    <p className="small mod-suspended">
                      <span>정지 사유: {p.suspendedReason ?? '(적지 않음)'}</span>{' '}
                      {!p.isAdmin && (
                        <button
                          type="button"
                          className="btn-link"
                          disabled={busyId === p.id}
                          onClick={() => void unsuspend(p)}
                        >
                          {busyId === p.id ? '푸는 중…' : '정지 풀기'}
                        </button>
                      )}
                    </p>
                  ) : (
                    !p.isAdmin && (
                      <div className="form-actions mod-suspend-form">
                        <select
                          aria-label={`${p.nickname} 정지 기간`}
                          value={d.days}
                          onChange={(e) => setDraft({ ...draft, [p.id]: { ...d, days: e.target.value } })}
                        >
                          {SUSPEND_OPTIONS.map((o) => (
                            <option key={o.label} value={String(o.days)}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                        <input
                          id={`suspend-reason-${p.id}`}
                          type="text"
                          maxLength={200}
                          required
                          value={d.reason}
                          placeholder="정지 사유 (본인에게 보여요)"
                          aria-label={`${p.nickname} 정지 사유`}
                          aria-invalid={missing || undefined}
                          aria-describedby={missing ? `suspend-reason-msg-${p.id}` : undefined}
                          onChange={(e) => {
                            if (missing) setReasonMissing(null);
                            setDraft({ ...draft, [p.id]: { ...d, reason: e.target.value } });
                          }}
                        />
                        <button
                          type="button"
                          className="btn btn-sm btn-danger"
                          disabled={busyId === p.id}
                          onClick={() => void suspend(p)}
                        >
                          {busyId === p.id ? '정지하는 중…' : `${suspendLabel(days)} 정지하기`}
                        </button>
                        {missing && (
                          <p id={`suspend-reason-msg-${p.id}`} className="warn small mod-suspend-msg" role="alert">
                            정지 사유를 써 주세요. 정지된 사람에게 보여요.
                          </p>
                        )}
                      </div>
                    )
                  )}
                </li>
              );
            })}
          </ul>
        ))}
    </section>
  );
}

// ─── AI 기종 추정 ────────────────────────────────────────────

function GuessesPanel() {
  const [list, setList] = useState<Load<{ guesses: GuessRow[] }>>({ kind: 'loading' });
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setList({ kind: 'loading' });
    setList(await getJson('/api/admin/guesses'));
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (g: GuessRow, approve: boolean) => {
    const key = `${g.arcadeId}:${g.machineId}`;
    setBusyKey(key);
    setError(null);
    const err = approve
      ? await send('/api/admin/guesses', {
          method: 'PUT',
          body: JSON.stringify({ arcadeId: g.arcadeId, machineId: g.machineId }),
        })
      : await send(`/api/admin/guesses?arcadeId=${g.arcadeId}&machineId=${g.machineId}`, { method: 'DELETE' });
    setBusyKey(null);
    if (err) {
      setError(err);
      return;
    }
    setList((prev) =>
      prev.kind === 'ready'
        ? { kind: 'ready', data: { guesses: prev.data.guesses.filter((x) => `${x.arcadeId}:${x.machineId}` !== key) } }
        : prev,
    );
  };

  return (
    <section aria-label="AI 기종 추정">
      <p className="muted small">
        상세 화면의 &quot;AI 로 기종 찾기&quot; 와 배치 스크립트가 찾은 기종입니다. 근거를 확인하고 승인하면 보유 기종에
        기체 1대로 들어갑니다. 대수 · 컨디션은 오락실 수정에서 고치세요.
      </p>
      {error && <p className="warn small" role="alert">{error}</p>}
      {list.kind === 'loading' && <p className="muted small">불러오는 중…</p>}
      {list.kind === 'failed' && <p className="warn small">{list.message}</p>}
      {list.kind === 'ready' &&
        (list.data.guesses.length === 0 ? (
          <p className="muted small">검수할 추정이 없습니다.</p>
        ) : (
          <ul className="mod-list">
            {list.data.guesses.map((g) => {
              const key = `${g.arcadeId}:${g.machineId}`;
              return (
                <li key={key} className="mod-card">
                  <div className="mod-card-head">
                    <strong>{g.arcadeName}</strong>
                    <span className="admin-badge">{g.machineName}</span>
                    {g.alreadyConfirmed && <span className="muted small">이미 보유 기종</span>}
                    <span className="muted small">{timeAgo(g.createdAt)}</span>
                  </div>
                  <p className="muted small">{g.address}</p>
                  <p className="mod-card-excerpt small">근거: {g.evidence}</p>
                  <div className="form-actions">
                    <a className="btn btn-sm" href={`/finder?arcade=${g.arcadeId}`} target="_blank" rel="noopener noreferrer">
                      오락실 보기
                    </a>
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      disabled={busyKey === key}
                      onClick={() => void act(g, true)}
                    >
                      {g.alreadyConfirmed ? '추정만 정리' : '승인'}
                    </button>
                    <button type="button" className="btn btn-sm" disabled={busyKey === key} onClick={() => void act(g, false)}>
                      버리기
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        ))}
    </section>
  );
}

/**
 * 오락실 정보 고침 제보 (migrate-087).
 *
 * 영업시간은 칸을 다듬은 뒤 "영업시간에 반영" 하면 오락실에 들어갑니다(출처: 이용자 제보).
 * 문 닫음 · 옮김 · 그 밖은 오락실을 지우거나 옮기는 일이라 여기서 자동으로 하지 않습니다 —
 * 오락실을 열어 고친 뒤 "확인했어요" 로 목록에서 치웁니다.
 */
function InfoReportsPanel() {
  const [list, setList] = useState<Load<{ reports: ArcadeInfoReportRow[] }>>({ kind: 'loading' });
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setList({ kind: 'loading' });
    setList(await getJson('/api/admin/info-reports'));
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (r: ArcadeInfoReportRow, action: 'apply' | 'dismiss') => {
    setBusyId(r.id);
    setError(null);
    const err = await send('/api/admin/info-reports', {
      method: 'PUT',
      body: JSON.stringify({
        id: r.id,
        action,
        hoursText: r.kind === 'hours' ? (drafts[r.id] ?? r.hoursText) : null,
      }),
    });
    setBusyId(null);
    if (err) {
      setError(err);
      return;
    }
    setList((prev) =>
      prev.kind === 'ready'
        ? { kind: 'ready', data: { reports: prev.data.reports.filter((x) => x.id !== r.id) } }
        : prev,
    );
  };

  return (
    <section aria-label="정보 고침">
      <p className="muted small">
        이용자가 상세의 &quot;정보가 달라요&quot; 로 보낸 내용이에요. 영업시간은 다듬어서 바로 반영할 수 있어요. 문 닫음 ·
        옮김은 오락실을 열어 직접 고친 뒤 &quot;확인했어요&quot; 를 눌러 주세요.
      </p>
      {error && <p className="warn small" role="alert">{error}</p>}
      {list.kind === 'loading' && <p className="muted small">불러오는 중…</p>}
      {list.kind === 'failed' && <p className="warn small">{list.message}</p>}
      {list.kind === 'ready' &&
        (list.data.reports.length === 0 ? (
          <p className="muted small">새로 온 정보 고침 제보가 없어요.</p>
        ) : (
          <ul className="mod-list">
            {list.data.reports.map((r) => (
              <li key={r.id} className="mod-card">
                <div className="mod-card-head">
                  <strong>{r.arcadeName}</strong>
                  <span className="admin-badge">{ARCADE_INFO_KIND_SHORT[r.kind]}</span>
                  <span className="muted small">
                    {r.nickname} · {timeAgo(r.createdAt)}
                  </span>
                </div>
                <p className="muted small">{r.address}</p>
                {r.kind === 'hours' && (
                  <>
                    <p className="muted small">지금 보이는 영업시간: {r.currentHours ?? '없음'}</p>
                    <label className="small" htmlFor={`info-hours-${r.id}`}>
                      반영할 영업시간
                    </label>
                    <input
                      id={`info-hours-${r.id}`}
                      type="text"
                      maxLength={INFO_HOURS_MAX}
                      value={drafts[r.id] ?? r.hoursText ?? ''}
                      onChange={(e) => setDrafts((d) => ({ ...d, [r.id]: e.target.value }))}
                    />
                  </>
                )}
                {r.detail && <p className="mod-card-excerpt small">{r.detail}</p>}
                <div className="form-actions">
                  <a className="btn btn-sm" href={`/finder?arcade=${r.arcadeId}`} target="_blank" rel="noopener noreferrer">
                    오락실 보기
                  </a>
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    disabled={busyId === r.id || (r.kind === 'hours' && !(drafts[r.id] ?? r.hoursText ?? '').trim())}
                    onClick={() => void act(r, 'apply')}
                  >
                    {r.kind === 'hours' ? '영업시간에 반영' : '확인했어요'}
                  </button>
                  <button type="button" className="btn btn-sm" disabled={busyId === r.id} onClick={() => void act(r, 'dismiss')}>
                    버리기
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ))}
    </section>
  );
}

export default function AdminConsole() {
  const user = useSession();
  const [tab, setTab] = useState<Tab>('reports');

  if (!user?.isAdmin) return <NotFound />;

  return (
    <main className="admin-page">
      <header className="admin-head">
        <div>
          <p className="eyebrow muted small">관리자</p>
          <h1>관리</h1>
          <p className="muted small">사용자가 낸 신고 · 정보 고침 제보, 계정 정지, AI 가 찾은 보유 기종을 처리해요.</p>
        </div>
        <div className="form-actions">
          <Link className="btn btn-sm" href="/admin/emoticons">
            이모티콘 관리
          </Link>
          <Link className="btn btn-sm" href="/account">
            내 정보로
          </Link>
        </div>
      </header>

      <div className="mod-tabs" role="tablist" aria-label="관리 항목">
        {(Object.keys(TAB_LABEL) as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className={tab === t ? 'btn btn-on' : 'btn'}
            onClick={() => setTab(t)}
          >
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>

      <div className="admin-card">
        {tab === 'reports' && <ReportsPanel />}
        {tab === 'info' && <InfoReportsPanel />}
        {tab === 'players' && <PlayersPanel />}
        {tab === 'guesses' && <GuessesPanel />}
      </div>
    </main>
  );
}
