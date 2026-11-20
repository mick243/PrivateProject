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
  type AdminPlayerRow,
  type GuessRow,
  type ReportGroup,
  type ReportReason,
  type ReportStatus,
} from '@/lib/moderation-types';
import { useSession } from '@/lib/use-session';

/**
 * 관리 화면 (`/admin`). **관리자만.** — 신고함 · 계정 · AI 기종 추정 세 칸.
 *
 * 2026-11-20 전에는 관리자 화면이 이모티콘 관리 하나뿐이라, 신고는 메일로 받고 계정 정지 · AI 추정
 * 승인은 DB 를 직접 고쳐야 했습니다. 이 화면이 부르는 API 는 전부 requireAdmin 을 지납니다
 * (app/api/admin/*). 관리자가 아니면 /admin/emoticons 와 같이 "없는 주소" 화면을 보여 줍니다.
 *
 * 되돌릴 수 없는 동작(지우기 · 무기한 정지)만 한 번 묻습니다. 기각 · 정지 풀기 · 추정 버리기는
 * 다시 할 수 있으므로 묻지 않습니다.
 */

type Tab = 'reports' | 'players' | 'guesses';
const TAB_LABEL: Record<Tab, string> = { reports: '신고함', players: '계정', guesses: 'AI 기종 추정' };

type Load<T> = { kind: 'loading' } | { kind: 'failed'; message: string } | { kind: 'ready'; data: T };

async function errorOf(res: Response, fallback: string): Promise<string> {
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return data.error ?? fallback;
}

async function getJson<T>(url: string): Promise<Load<T>> {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return { kind: 'failed', message: await errorOf(res, '불러오지 못했습니다') };
    return { kind: 'ready', data: (await res.json()) as T };
  } catch {
    return { kind: 'failed', message: '네트워크 오류' };
  }
}

/** 요청 하나 — 실패하면 문구, 성공하면 null */
async function send(url: string, init: RequestInit): Promise<string | null> {
  try {
    const res = await fetch(url, {
      ...init,
      headers: init.body ? { 'content-type': 'application/json' } : undefined,
    });
    return res.ok ? null : await errorOf(res, '처리하지 못했습니다');
  } catch {
    return '네트워크 오류';
  }
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
    if (action === 'delete' && !window.confirm(`이 ${what}을(를) 지울까요? 되돌릴 수 없습니다.`)) return;
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

function PlayersPanel() {
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [list, setList] = useState<Load<{ players: AdminPlayerRow[] }>>({ kind: 'loading' });
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
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

  const suspend = async (p: AdminPlayerRow) => {
    const d = draftOf(p.id);
    const days = d.days === 'null' ? null : Number(d.days);
    if (days === null && !window.confirm(`${p.nickname} 님을 무기한 정지할까요?`)) return;
    setBusyId(p.id);
    setError(null);
    const err = await send(`/api/admin/players/${p.id}/suspension`, {
      method: 'PUT',
      body: JSON.stringify({ days, reason: d.reason.trim() || null }),
    });
    setBusyId(null);
    if (err) setError(err);
    else void load();
  };

  const unsuspend = async (p: AdminPlayerRow) => {
    setBusyId(p.id);
    setError(null);
    const err = await send(`/api/admin/players/${p.id}/suspension`, { method: 'DELETE' });
    setBusyId(null);
    if (err) setError(err);
    else void load();
  };

  return (
    <section aria-label="계정">
      <form
        className="admin-toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(q.trim());
        }}
      >
        <input
          className="admin-search"
          type="search"
          value={q}
          placeholder="닉네임 또는 id"
          aria-label="계정 찾기"
          onChange={(e) => setQ(e.target.value)}
        />
        <button type="submit" className="btn btn-sm">
          찾기
        </button>
      </form>
      <p className="muted small">
        {query
          ? `'${query}' 로 찾은 계정입니다.`
          : '처리 전 신고가 들어온 사람과 정지 중인 사람입니다. 다른 계정은 위에서 찾으세요.'}{' '}
        정지하면 그 계정의 로그인이 바로 끊기고, 다시 로그인하면 정지 사유를 봅니다.
      </p>
      {error && <p className="warn small" role="alert">{error}</p>}
      {list.kind === 'loading' && <p className="muted small">불러오는 중…</p>}
      {list.kind === 'failed' && <p className="warn small">{list.message}</p>}
      {list.kind === 'ready' &&
        (list.data.players.length === 0 ? (
          <p className="muted small">{query ? '찾은 계정이 없습니다.' : '손볼 계정이 없습니다.'}</p>
        ) : (
          <ul className="mod-list">
            {list.data.players.map((p) => {
              const d = draftOf(p.id);
              return (
                <li key={p.id} className="mod-card">
                  <div className="mod-card-head">
                    <strong>{p.nickname}</strong>
                    <span className="muted small">#{p.id} · 가입 {timeAgo(p.createdAt)}</span>
                    {p.isAdmin && <span className="admin-badge">관리자</span>}
                    {p.openReports > 0 && <span className="admin-badge is-gone">처리 전 신고 {p.openReports}</span>}
                    {p.suspendedUntil && (
                      <span className="admin-badge is-gone">
                        {isIndefinite(p.suspendedUntil)
                          ? '무기한 정지'
                          : `정지 ~${new Date(p.suspendedUntil).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' })}`}
                      </span>
                    )}
                  </div>
                  <p className="muted small">
                    글 {p.posts} · 댓글 {p.comments} · 리뷰 {p.reviews}
                    {p.suspendedReason && ` · 정지 사유: ${p.suspendedReason}`}
                  </p>
                  {!p.isAdmin && (
                    <div className="form-actions">
                      {p.suspendedUntil ? (
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={busyId === p.id}
                          onClick={() => void unsuspend(p)}
                        >
                          정지 풀기
                        </button>
                      ) : (
                        <>
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
                            type="text"
                            maxLength={200}
                            value={d.reason}
                            placeholder="사유 (본인에게 보입니다)"
                            aria-label={`${p.nickname} 정지 사유`}
                            onChange={(e) => setDraft({ ...draft, [p.id]: { ...d, reason: e.target.value } })}
                          />
                          <button
                            type="button"
                            className="btn btn-sm btn-danger"
                            disabled={busyId === p.id}
                            onClick={() => void suspend(p)}
                          >
                            정지
                          </button>
                        </>
                      )}
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
          <p className="muted small">사용자가 낸 신고, 계정 정지, AI 가 찾은 보유 기종을 처리합니다.</p>
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
        {tab === 'players' && <PlayersPanel />}
        {tab === 'guesses' && <GuessesPanel />}
      </div>
    </main>
  );
}
