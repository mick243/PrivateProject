'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  EMOTICON_ADMIN_PAGE_SIZE,
  EMOTICON_MAX_BYTES,
  EMOTICON_NAME_MAX,
  timeAgo,
  type EmoticonAdminRow,
  type EmoticonStatus,
} from '@/lib/community-types';
import { refreshEmoticons } from '@/lib/use-emoticons';
import { useSession } from '@/lib/use-session';
import Pagination from './Pagination';

/**
 * 이모티콘 관리 페이지 (`/admin/emoticons`). **관리자만.**
 *
 * 화면 판정은 세션 스토어(lib/use-session.ts)로, 실제 판정은 서버가 합니다 —
 * 이 화면이 부르는 API 는 전부 requireAdmin 을 지납니다. 관리자가 아닌 사람에게는
 * 403 이 아니라 **없는 주소와 같은 화면**을 보여 줍니다(app/not-found.tsx 와 같은
 * 문구). "관리자 전용입니다" 는 그 자리에 무엇이 있는지를 알려 주는 말입니다.
 *
 * 목록은 서버가 페이지를 나눠 줍니다(GET /api/emoticons/admin → { rows, total }).
 * 고르는 칸(EmoticonPicker)이 전체를 한 번에 받는 것과 다른 이유는 여기서는
 * 지운 것까지 보고, 줄마다 미리보기 그림이 뜨기 때문입니다.
 *
 * 줄 단위 동작(빼기 · 되살리기 · 이름 바꾸기)은 **그 줄만 잠그고 낙관적으로**
 * 바꾼 뒤 실패하면 되돌립니다 — 매번 목록을 다시 받으면 미리보기 그림 24장이
 * 깜빡입니다. 등록은 새 줄이 어느 페이지에 들어갈지 서버가 정하므로 다시 받습니다.
 */

const ACCEPT = 'image/jpeg,image/png,image/gif';
const MB = Math.round(EMOTICON_MAX_BYTES / 1024 / 1024);

const STATUS_LABEL: Record<EmoticonStatus, string> = {
  live: '쓰는 중',
  deleted: '지운 것',
  all: '전체',
};

type ListState =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'ready'; rows: EmoticonAdminRow[]; total: number };

const fmtBytes = (n: number): string =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

async function errorOf(res: Response, fallback: string): Promise<string> {
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return data.error ?? fallback;
}

export default function EmoticonAdmin() {
  const user = useSession();

  const [status, setStatus] = useState<EmoticonStatus>('live');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [list, setList] = useState<ListState>({ kind: 'loading' });
  /** 지금 서버와 이야기 중인 줄. 같은 줄에 두 번 누르지 못하게 */
  const [busyId, setBusyId] = useState<number | null>(null);
  const [rowError, setRowError] = useState<{ id: number; message: string } | null>(null);
  /** 이름 바꾸기 중인 줄과 입력값 */
  const [editing, setEditing] = useState<{ id: number; name: string } | null>(null);

  // 등록 폼
  const [newName, setNewName] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const isAdmin = user?.isAdmin === true;

  const load = useCallback(async () => {
    setList({ kind: 'loading' });
    const sp = new URLSearchParams({
      status,
      page: String(page),
      pageSize: String(EMOTICON_ADMIN_PAGE_SIZE),
    });
    if (q.trim() !== '') sp.set('q', q.trim());
    try {
      const res = await fetch(`/api/emoticons/admin?${sp}`, { cache: 'no-store' });
      if (!res.ok) {
        setList({ kind: 'failed', message: await errorOf(res, '목록을 불러오지 못했습니다') });
        return;
      }
      const data = (await res.json()) as { rows: EmoticonAdminRow[]; total: number };
      setList({ kind: 'ready', rows: data.rows, total: data.total });
    } catch {
      setList({ kind: 'failed', message: '네트워크 오류' });
    }
  }, [status, page, q]);

  useEffect(() => {
    if (!isAdmin) return;
    let alive = true;
    void load().then(() => {
      if (!alive) return;
    });
    return () => {
      alive = false;
    };
  }, [isAdmin, load]);

  /** 필터가 바뀌면 1페이지로 — 3페이지에서 검색어를 치면 결과가 3페이지엔 없습니다 */
  const changeStatus = (s: EmoticonStatus) => {
    setStatus(s);
    setPage(1);
  };
  const search = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    void load();
  };

  const patchRow = (id: number, patch: Partial<EmoticonAdminRow>) =>
    setList((prev) =>
      prev.kind === 'ready'
        ? { ...prev, rows: prev.rows.map((r) => (r.id === id ? { ...r, ...patch } : r)) }
        : prev,
    );

  /**
   * 빼기 / 되살리기. 낙관적으로 deletedAt 을 먼저 바꾸고 실패하면 되돌립니다.
   * "쓰는 중" 탭에서 뺀 줄은 그 자리에 흐리게 남습니다 — 곧바로 사라지면 잘못
   * 눌렀을 때 되살릴 단추가 없습니다. 다음 불러오기에서 빠집니다.
   */
  const toggle = async (row: EmoticonAdminRow) => {
    const deleting = row.deletedAt === null;
    if (
      deleting &&
      !window.confirm(`'${row.name}' 을(를) 목록에서 뺄까요?\n이미 쓰인 댓글은 이름표로 남고, 여기서 되살릴 수 있습니다.`)
    ) {
      return;
    }
    setBusyId(row.id);
    setRowError(null);
    patchRow(row.id, { deletedAt: deleting ? new Date().toISOString() : null });
    try {
      const res = deleting
        ? await fetch(`/api/emoticons/${row.id}`, { method: 'DELETE' })
        : await fetch(`/api/emoticons/${row.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ restore: true }),
          });
      if (!res.ok) {
        patchRow(row.id, { deletedAt: row.deletedAt });
        setRowError({ id: row.id, message: await errorOf(res, deleting ? '빼지 못했습니다' : '되살리지 못했습니다') });
        return;
      }
      // 열려 있는 고르는 칸들이 같이 바뀌도록
      void refreshEmoticons();
    } catch {
      patchRow(row.id, { deletedAt: row.deletedAt });
      setRowError({ id: row.id, message: '네트워크 오류' });
    } finally {
      setBusyId(null);
    }
  };

  const rename = async (row: EmoticonAdminRow) => {
    if (!editing || editing.id !== row.id) return;
    const name = editing.name.trim().replace(/\s+/g, ' ');
    if (name === '') {
      setRowError({ id: row.id, message: '이름을 입력해 주세요' });
      return;
    }
    if (name === row.name) {
      setEditing(null);
      return;
    }
    setBusyId(row.id);
    setRowError(null);
    patchRow(row.id, { name });
    try {
      const res = await fetch(`/api/emoticons/${row.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        patchRow(row.id, { name: row.name });
        setRowError({ id: row.id, message: await errorOf(res, '이름을 바꾸지 못했습니다') });
        return;
      }
      setEditing(null);
      void refreshEmoticons();
    } catch {
      patchRow(row.id, { name: row.name });
      setRowError({ id: row.id, message: '네트워크 오류' });
    } finally {
      setBusyId(null);
    }
  };

  const upload = async (e: React.FormEvent) => {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setUploadError('올릴 그림을 골라 주세요');
      return;
    }
    if (newName.trim() === '') {
      setUploadError('이름을 입력해 주세요');
      return;
    }
    setUploading(true);
    setUploadError(null);
    setUploaded(null);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('name', newName.trim());
      const res = await fetch('/api/emoticons', { method: 'POST', body: form });
      if (!res.ok) {
        setUploadError(await errorOf(res, '등록에 실패했습니다'));
        return;
      }
      const data = (await res.json()) as { emoticon: { name: string } };
      setUploaded(data.emoticon.name);
      setNewName('');
      if (fileRef.current) fileRef.current.value = '';
      // 새 줄은 "쓰는 중" 첫 페이지 맨 위에 옵니다 — 거기로 옮겨 다시 받습니다.
      setStatus('live');
      setPage(1);
      void refreshEmoticons();
      void load();
    } catch {
      setUploadError('네트워크 오류');
    } finally {
      setUploading(false);
    }
  };

  // ── 접근 판정 ──────────────────────────────────────────
  // 세션은 첫 마운트 뒤에 오므로, 그 전에는 "불러오는 중" 만 — 관리자에게 404 를
  // 한 순간 보여 주고 바꾸면 화면이 튑니다.
  if (user === null) {
    return (
      <main className="login-page">
        <section className="login-card">
          <h1>이런 주소는 없어요</h1>
          <p className="muted small">
            주소가 바뀌었거나 잘못 적힌 것 같아요. 오락실은 지도에서, 글은 커뮤니티에서 다시
            찾아 주세요.
          </p>
          <div className="form-actions">
            <Link className="btn btn-primary btn-sm" href="/">
              오락실 파인더
            </Link>
            <Link className="btn btn-sm" href="/community">
              커뮤니티
            </Link>
          </div>
        </section>
      </main>
    );
  }
  if (!isAdmin) {
    // 위와 같은 화면입니다. 로그인은 했지만 관리자가 아닌 사람 — 여기가 무엇인지 알릴 이유가 없습니다.
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

  const total = list.kind === 'ready' ? list.total : 0;

  return (
    <main className="admin-page">
      <header className="admin-head">
        <div>
          <p className="eyebrow muted small">관리자</p>
          <h1>이모티콘 관리</h1>
          <p className="muted small">
            댓글·리뷰·채보 평가의 고르는 칸에 뜨는 그림입니다. 여기서 빼도 이미 쓰인 자리는
            이름표로 남고, 되살리면 다시 그림이 됩니다.
          </p>
        </div>
        <Link className="btn btn-sm" href="/account">
          내 정보로
        </Link>
      </header>

      <form className="admin-card emoticon-upload" onSubmit={upload}>
        <h2>새 이모티콘 등록</h2>
        <p className="muted small">JPG · PNG · GIF, {MB}MB 까지. 형식은 파일 내용으로 판정합니다.</p>
        <div className="emoticon-upload-row">
          <input type="file" accept={ACCEPT} ref={fileRef} disabled={uploading} />
          <input
            type="text"
            placeholder={`이름 (${EMOTICON_NAME_MAX}자까지, 예: 박수)`}
            maxLength={EMOTICON_NAME_MAX}
            value={newName}
            disabled={uploading}
            onChange={(ev) => setNewName(ev.target.value)}
          />
          <button type="submit" className="btn btn-sm btn-primary" disabled={uploading}>
            {uploading ? '올리는 중…' : '등록'}
          </button>
        </div>
        {uploadError && <p className="warn small">{uploadError}</p>}
        {uploaded && !uploadError && <p className="muted small">&apos;{uploaded}&apos; 을(를) 등록했습니다.</p>}
      </form>

      <section className="admin-card">
        <div className="admin-toolbar">
          <div className="seg seg-sm" role="tablist" aria-label="상태">
            {(Object.keys(STATUS_LABEL) as EmoticonStatus[]).map((s) => (
              <button
                key={s}
                type="button"
                role="tab"
                aria-selected={status === s}
                className={status === s ? 'is-on' : undefined}
                onClick={() => changeStatus(s)}
              >
                {STATUS_LABEL[s]}
              </button>
            ))}
          </div>
          <form className="admin-search" onSubmit={search} role="search">
            <input
              type="search"
              placeholder="이름으로 찾기"
              value={q}
              maxLength={EMOTICON_NAME_MAX}
              onChange={(ev) => setQ(ev.target.value)}
            />
            <button type="submit" className="btn btn-sm">
              찾기
            </button>
          </form>
          <span className="muted small admin-count">
            {list.kind === 'ready' ? `${total.toLocaleString()}개` : ''}
          </span>
        </div>

        {list.kind === 'loading' && <p className="muted pad">불러오는 중…</p>}
        {list.kind === 'failed' && (
          <div className="pad">
            <p className="warn small">{list.message}</p>
            <button type="button" className="btn btn-sm" onClick={() => void load()}>
              다시 시도
            </button>
          </div>
        )}
        {list.kind === 'ready' && list.rows.length === 0 && (
          <p className="muted pad">
            {q.trim() !== ''
              ? '그런 이름의 이모티콘이 없습니다.'
              : status === 'deleted'
                ? '지운 이모티콘이 없습니다.'
                : '아직 등록된 이모티콘이 없습니다. 위에서 첫 이모티콘을 올려 주세요.'}
          </p>
        )}
        {list.kind === 'ready' && list.rows.length > 0 && (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th scope="col">미리보기</th>
                  <th scope="col">이름</th>
                  <th scope="col">형식 · 크기</th>
                  <th scope="col">올린 사람</th>
                  <th scope="col">올린 때</th>
                  <th scope="col">상태</th>
                  <th scope="col">
                    <span className="sr-only">동작</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.rows.map((row) => {
                  const gone = row.deletedAt !== null;
                  const busy = busyId === row.id;
                  const isEditing = editing?.id === row.id;
                  return (
                    <tr key={row.id} className={gone ? 'is-gone' : undefined}>
                      <td>
                        {/* eslint-disable-next-line @next/next/no-img-element -- 사용자 업로드라 크기가 제각각입니다 */}
                        <img className="admin-thumb" src={row.url} alt={row.name} loading="lazy" />
                      </td>
                      <td>
                        {isEditing ? (
                          <form
                            className="admin-inline-form"
                            onSubmit={(ev) => {
                              ev.preventDefault();
                              void rename(row);
                            }}
                          >
                            <input
                              autoFocus
                              type="text"
                              maxLength={EMOTICON_NAME_MAX}
                              value={editing.name}
                              disabled={busy}
                              onChange={(ev) => setEditing({ id: row.id, name: ev.target.value })}
                              onKeyDown={(ev) => {
                                if (ev.key === 'Escape') setEditing(null);
                              }}
                            />
                            <button type="submit" className="btn btn-sm btn-primary" disabled={busy}>
                              저장
                            </button>
                            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setEditing(null)}>
                              취소
                            </button>
                          </form>
                        ) : (
                          <>
                            <b>{row.name}</b>
                            <span className="muted small admin-id"> #{row.id}</span>
                          </>
                        )}
                        {rowError?.id === row.id && <p className="warn small">{rowError.message}</p>}
                      </td>
                      <td className="muted small">
                        {row.mime.replace('image/', '').toUpperCase()} · {fmtBytes(row.bytes)}
                      </td>
                      <td className="small">{row.createdBy ?? <span className="muted">(탈퇴)</span>}</td>
                      <td className="muted small" title={row.createdAt}>
                        {timeAgo(row.createdAt)}
                      </td>
                      <td className="small">
                        {gone ? (
                          <span className="admin-badge is-gone" title={row.deletedAt ?? undefined}>
                            지움 · {timeAgo(row.deletedAt as string)}
                          </span>
                        ) : (
                          <span className="admin-badge">쓰는 중</span>
                        )}
                      </td>
                      <td className="admin-actions">
                        {!gone && !isEditing && (
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={busy}
                            onClick={() => setEditing({ id: row.id, name: row.name })}
                          >
                            이름
                          </button>
                        )}
                        <button
                          type="button"
                          className={gone ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-danger'}
                          disabled={busy}
                          onClick={() => void toggle(row)}
                        >
                          {busy ? '…' : gone ? '되살리기' : '빼기'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {list.kind === 'ready' && (
          <Pagination page={page} total={total} pageSize={EMOTICON_ADMIN_PAGE_SIZE} onChange={setPage} />
        )}
      </section>
    </main>
  );
}
