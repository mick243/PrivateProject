'use client';

import { useEffect, useId, useRef, useState } from 'react';
import {
  REPORT_DETAIL_MAX,
  REPORT_REASON_LABEL,
  REPORT_REASONS,
  REPORT_TARGET_LABEL,
  type ReportReason,
  type ReportTarget,
} from '@/lib/moderation-types';
import { setBlocked, useBlockedIds } from '@/lib/use-blocks';
import { usePlayerId } from '@/lib/use-player';

interface Props {
  targetType: ReportTarget;
  targetId: number;
  author: { playerId: number; nickname: string };
}

/**
 * 글 · 댓글 · 리뷰 · 채보 평가 옆의 "신고 · 차단" 단추.
 *
 * 로그인했고 **남의 것**일 때만 그립니다 — 비로그인에게 단추를 보여 주고 누르면 "로그인하세요" 라고
 * 하느니 아예 두지 않습니다(신고는 계정 단위로 세야 도배가 안 됩니다). 내 것에는 이미 수정 · 삭제가 있습니다.
 *
 * 신고는 사유 하나를 고르고 설명을 덧붙일 수 있습니다(선택). 접수되면 관리자 화면(/admin)의 신고함으로
 * 갑니다. 차단은 한 번 묻고 바로 가립니다 — 계정 화면에서 풀 수 있습니다.
 */
export default function ReportMenu({ targetType, targetId, author }: Props) {
  const playerId = usePlayerId();
  const blockedIds = useBlockedIds();
  const [open, setOpen] = useState<'menu' | 'report' | null>(null);
  const [reason, setReason] = useState<ReportReason>('spam');
  const [detail, setDetail] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const formId = useId();
  /** 연 단추 — 닫으면 초점을 여기로 돌려준다 (UX 시험 C-3: 신고 폼이 Esc 로 안 닫히고 초점이 body 로 갔다) */
  const triggerRef = useRef<HTMLButtonElement>(null);
  const firstFieldRef = useRef<HTMLSelectElement>(null);
  const firstItemRef = useRef<HTMLButtonElement>(null);

  // 메뉴 → 신고 폼으로 바뀌면 누른 메뉴 항목이 사라져 초점이 body 로 떨어진다 — 폼의 첫 칸으로 옮긴다.
  // 메뉴를 열면 첫 항목으로 옮긴다.
  useEffect(() => {
    if (open === 'report') firstFieldRef.current?.focus();
    else if (open === 'menu') firstItemRef.current?.focus();
  }, [open]);

  /** 닫고 연 단추로 초점을 돌려준다 */
  const close = () => {
    setOpen(null);
    triggerRef.current?.focus();
  };

  if (playerId === null || playerId === author.playerId) return null;
  const isBlocked = blockedIds.has(author.playerId);
  const what = REPORT_TARGET_LABEL[targetType];

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/content-reports', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetType, targetId, reason, detail: detail.trim() || null }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; duplicate?: boolean };
      if (!res.ok) {
        setMessage({ text: data.error ?? '신고를 보내지 못했어요. 다시 시도해 주세요', ok: false });
        return;
      }
      setMessage({
        text: data.duplicate ? '이미 신고한 글이에요. 관리자가 확인할 거예요.' : '신고했어요. 관리자가 확인한 뒤 처리해요.',
        ok: true,
      });
      close();
      setDetail('');
    } catch {
      setMessage({ text: '연결이 잠깐 끊겼어요. 다시 시도해 주세요', ok: false });
    } finally {
      setBusy(false);
    }
  };

  const toggleBlock = async () => {
    if (!isBlocked && !window.confirm(`${author.nickname} 님을 차단할까요?\n이 사람의 글 · 댓글 · 리뷰가 내 화면에서 가려져요. 상대에게는 알리지 않고, 내 정보에서 풀 수 있어요.`)) {
      return;
    }
    setBusy(true);
    const error = await setBlocked(author, !isBlocked);
    setBusy(false);
    close();
    setMessage(error ? { text: error, ok: false } : { text: isBlocked ? '차단을 풀었어요.' : '차단했어요.', ok: true });
  };

  return (
    <span
      className="report-menu"
      onKeyDown={(e) => {
        // Esc 로 메뉴 · 신고 폼을 닫는다. 상세 패널 등 바깥의 Esc 처리까지 닫히지 않게 여기서 멈춘다.
        if (e.key === 'Escape' && open !== null) {
          e.stopPropagation();
          close();
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="btn btn-sm btn-ghost"
        aria-haspopup="true"
        aria-expanded={open !== null}
        aria-label={`${what} 신고 · 차단`}
        title="신고 · 차단"
        onClick={() => setOpen(open === null ? 'menu' : null)}
      >
        ⋯
      </button>

      {open === 'menu' && (
        <span className="report-menu-pop" role="menu">
          <button ref={firstItemRef} type="button" role="menuitem" className="btn btn-sm" onClick={() => setOpen('report')}>
            {what} 신고
          </button>
          <button type="button" role="menuitem" className="btn btn-sm" disabled={busy} onClick={toggleBlock}>
            {isBlocked ? `${author.nickname} 님 차단 풀기` : `${author.nickname} 님 차단`}
          </button>
        </span>
      )}

      {open === 'report' && (
        <form className="report-form" onSubmit={submit} aria-label={`${what} 신고`}>
          <label htmlFor={`${formId}-reason`}>신고 사유</label>
          <select ref={firstFieldRef} id={`${formId}-reason`} value={reason} onChange={(e) => setReason(e.target.value as ReportReason)}>
            {REPORT_REASONS.map((r) => (
              <option key={r} value={r}>
                {REPORT_REASON_LABEL[r]}
              </option>
            ))}
          </select>
          <label htmlFor={`${formId}-detail`}>설명 (선택)</label>
          <textarea
            id={`${formId}-detail`}
            rows={2}
            maxLength={REPORT_DETAIL_MAX}
            value={detail}
            placeholder="관리자가 알아야 할 것이 있으면 적어 주세요"
            onChange={(e) => setDetail(e.target.value)}
          />
          <div className="form-actions">
            <button type="button" className="btn-link" onClick={close}>
              취소
            </button>
            <button type="submit" className="btn btn-sm btn-primary" disabled={busy}>
              신고 보내기
            </button>
          </div>
        </form>
      )}

      {message && (
        <span className={message.ok ? 'report-msg muted small' : 'report-msg warn small'} role="status" aria-live="polite">
          {message.text}
        </span>
      )}
    </span>
  );
}
