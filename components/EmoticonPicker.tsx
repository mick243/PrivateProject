'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import {
  EMOTICON_MAX_BYTES,
  EMOTICON_NAME_MAX,
  emoticonToken,
} from '@/lib/community-types';
import { refreshEmoticons, useEmoticons } from '@/lib/use-emoticons';
import { useIsAdmin } from '@/lib/use-session';

/**
 * 이모티콘을 고르는 단추 (등록 단추 오른쪽).
 *
 * 고른 것은 본문 **끝에** `[[emo:N]]` 로 붙습니다. 커서 자리에 끼워 넣지 않는
 * 이유는 세 화면(댓글·리뷰·채보 평가)이 각자 textarea 를 들고 있어서, 커서
 * 자리를 알려면 세 곳 모두에 ref 를 심어야 하기 때문입니다. 이모티콘은 대개
 * 끝에 붙이는 것이라 그 값어치가 없습니다.
 *
 * 등록(업로드)은 관리자에게만 보입니다. 목록이 공용이라 한 장이 모든 화면에
 * 뜨기 때문입니다 — 판정은 화면이 아니라 서버가 합니다(app/api/emoticons POST).
 */

const ACCEPT = 'image/jpeg,image/png,image/gif';
const MB = Math.round(EMOTICON_MAX_BYTES / 1024 / 1024);

export default function EmoticonPicker({
  onPick,
  disabled = false,
}: {
  onPick: (token: string) => void;
  disabled?: boolean;
}) {
  const emoticons = useEmoticons();
  const isAdmin = useIsAdmin();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // 바깥을 누르거나 Esc 를 누르면 닫습니다. 열려 있는 채로 글을 쓰면 칸을 가립니다.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const upload = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError('올릴 그림을 골라 주세요');
      return;
    }
    if (name.trim() === '') {
      setError('이름을 입력해 주세요');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('name', name.trim());
      const res = await fetch('/api/emoticons', { method: 'POST', body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? '등록에 실패했습니다');
        return;
      }
      setName('');
      if (fileRef.current) fileRef.current.value = '';
      await refreshEmoticons();
    } catch {
      setError('네트워크 오류');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: number, label: string) => {
    if (!window.confirm(`'${label}' 이모티콘을 목록에서 뺄까요? 이미 쓰인 댓글은 그대로 남습니다.`)) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/emoticons/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? '삭제에 실패했습니다');
        return;
      }
      await refreshEmoticons();
    } catch {
      setError('네트워크 오류');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="emoticon-picker" ref={boxRef}>
      <button
        type="button"
        className="btn btn-sm emoticon-btn"
        aria-expanded={open}
        aria-label="이모티콘"
        title="이모티콘"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <circle cx="9" cy="10" r="1.2" fill="currentColor" />
          <circle cx="15" cy="10" r="1.2" fill="currentColor" />
          <path
            d="M8 14.5c1 1.2 2.4 1.8 4 1.8s3-.6 4-1.8"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      </button>

      {open && (
        <div className="emoticon-panel">
          {emoticons.length === 0 ? (
            <p className="muted small emoticon-empty">
              {isAdmin ? '아직 등록된 이모티콘이 없습니다. 아래에서 올려 주세요.' : '아직 등록된 이모티콘이 없습니다.'}
            </p>
          ) : (
            <ul className="emoticon-grid">
              {emoticons.map((e) => (
                <li key={e.id}>
                  <button
                    type="button"
                    className="emoticon-cell"
                    title={e.name}
                    onClick={() => onPick(emoticonToken(e.id))}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- 사용자 업로드라 크기가 제각각입니다 */}
                    <img src={e.url} alt={e.name} loading="lazy" />
                  </button>
                  {isAdmin && (
                    <button
                      type="button"
                      className="emoticon-del"
                      title="이 이모티콘 빼기"
                      aria-label={`${e.name} 빼기`}
                      disabled={busy}
                      onClick={() => void remove(e.id, e.name)}
                    >
                      ×
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          {isAdmin && (
            <div className="emoticon-add">
              <p className="muted small">
                관리자 · JPG · PNG · GIF, {MB}MB 까지 ·{' '}
                <Link href="/admin/emoticons">관리 페이지</Link>
              </p>
              <input type="file" accept={ACCEPT} ref={fileRef} disabled={busy} />
              <div className="emoticon-add-row">
                <input
                  type="text"
                  placeholder="이름 (예: 박수)"
                  maxLength={EMOTICON_NAME_MAX}
                  value={name}
                  disabled={busy}
                  onChange={(ev) => setName(ev.target.value)}
                />
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={busy}
                  onClick={() => void upload()}
                >
                  {busy ? '올리는 중…' : '등록'}
                </button>
              </div>
            </div>
          )}

          {error && <p className="warn small emoticon-error">{error}</p>}
        </div>
      )}
    </div>
  );
}
