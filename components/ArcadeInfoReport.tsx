'use client';

import Link from 'next/link';
import { useId, useState, type FormEvent } from 'react';
import {
  ARCADE_INFO_KIND_LABEL,
  ARCADE_INFO_KINDS,
  INFO_DETAIL_MAX,
  INFO_HOURS_MAX,
  infoFieldsOf,
  type ArcadeInfoKind,
} from '@/lib/arcade-info-report-types';
import { usePlayerId } from '@/lib/use-player';

interface Props {
  arcadeId: number;
  /** 영업시간을 모르는 곳이면 단추가 "영업시간 알려 주기" 가 되고 그 종류로 열립니다 */
  hoursUnknown: boolean;
}

/**
 * 상세의 "정보가 달라요" (migrate-087).
 *
 * 영업시간 · 문 닫음 · 옮김처럼 지도 앱에만 있던 정보를 이용자에게서 받습니다. 기종은 이미
 * 기종 블록의 「이 게임 있어요 / 없어졌어요」 제보가 맡으므로 여기서 받지 않습니다.
 * 보낸 것은 바로 바뀌지 않고 관리자가 확인한 뒤 반영된다는 것을 보낸 자리에서 알립니다.
 *
 * 닫혀 있을 때는 작은 단추 하나 — 상세의 주 행동(기종 제보)과 다투지 않게 btn-primary 를
 * 쓰지 않습니다. 열린 폼 안에서만 "보내기" 가 주 버튼입니다 (docs/DESIGN-GUIDE.md §1-2).
 */
export default function ArcadeInfoReport({ arcadeId, hoursUnknown }: Props) {
  const playerId = usePlayerId();
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<ArcadeInfoKind>('hours');
  const [hoursText, setHoursText] = useState('');
  const [detail, setDetail] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const fields = infoFieldsOf(kind);
  const opener = hoursUnknown ? '영업시간 알려 주기' : '정보가 달라요';

  const start = () => {
    setKind('hours');
    setMessage(null);
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    setHoursText('');
    setDetail('');
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/arcades/${arcadeId}/info-reports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind,
          hoursText: fields.hours ? hoursText : null,
          detail: detail || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage({ ok: false, text: data.error ?? '보내지 못했어요. 잠시 뒤 다시 보내 주세요' });
        return;
      }
      setMessage({ ok: true, text: data.message ?? '알려 주셔서 고마워요. 확인한 뒤 고칠게요.' });
      close();
    } catch {
      setMessage({ ok: false, text: '연결이 잠깐 끊겼어요. 다시 보내 주세요' });
    } finally {
      setBusy(false);
    }
  };

  if (!playerId) {
    return (
      <p className="muted small info-report">
        정보가 다르면 <Link href="/login?next=%2Ffinder">로그인</Link>하고 알려 주세요
      </p>
    );
  }

  return (
    <div className="info-report">
      {!open && (
        <button type="button" className="btn btn-sm" onClick={start}>
          {opener}
        </button>
      )}

      {open && (
        <form className="report-form" onSubmit={submit} aria-label="오락실 정보 고치기">
          <label htmlFor={`${formId}-kind`}>무엇이 다른가요?</label>
          <select
            id={`${formId}-kind`}
            value={kind}
            onChange={(e) => setKind(e.target.value as ArcadeInfoKind)}
          >
            {ARCADE_INFO_KINDS.map((k) => (
              <option key={k} value={k}>
                {ARCADE_INFO_KIND_LABEL[k]}
              </option>
            ))}
          </select>

          {fields.hours && (
            <>
              <label htmlFor={`${formId}-hours`}>영업시간</label>
              <input
                id={`${formId}-hours`}
                type="text"
                maxLength={INFO_HOURS_MAX}
                value={hoursText}
                placeholder="예: 평일 12:00~24:00, 주말 10:00~24:00"
                onChange={(e) => setHoursText(e.target.value)}
                required
              />
            </>
          )}

          <label htmlFor={`${formId}-detail`}>
            {kind === 'moved' ? '옮긴 곳' : '더 알려 줄 것'}
            {fields.detail === 'optional' && ' (선택)'}
          </label>
          <textarea
            id={`${formId}-detail`}
            rows={2}
            maxLength={INFO_DETAIL_MAX}
            value={detail}
            placeholder={
              kind === 'moved'
                ? '예: 같은 건물 2층으로 옮겼어요'
                : kind === 'closed'
                  ? '예: 11월에 가 보니 간판이 내려가 있었어요'
                  : '확인한 날이나 어디서 봤는지 적어 주면 빨리 고칠 수 있어요'
            }
            onChange={(e) => setDetail(e.target.value)}
            required={fields.detail === 'required'}
          />
          <p className="muted small">관리자가 확인한 뒤 고쳐요. 바로 바뀌지는 않아요.</p>
          <div className="form-actions">
            <button type="button" className="btn-link" onClick={close}>
              닫기
            </button>
            <button type="submit" className="btn btn-sm btn-primary" disabled={busy}>
              고칠 내용 보내기
            </button>
          </div>
        </form>
      )}

      {message && (
        <p className={message.ok ? 'notice small' : 'warn small'} role="status" aria-live="polite">
          {message.text}
        </p>
      )}
    </div>
  );
}
