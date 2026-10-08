'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ago,
  lasted,
  OPS_OPEN_PARAM,
  type OpsAlertCheck,
  type OpsAlertsResponse,
  type OpsAlertView,
} from '@/lib/ops-alert-types';
import { useIsAdmin } from '@/lib/use-session';

/**
 * 운영 알림 — 관리자에게만 보이는 떠 있는 종 아이콘과 요약 목록.
 *
 * Grafana Cloud 가 알림을 웹훅으로 보내면(POST /api/ops/alerts) 서버가 적고 Gemini 로 요약합니다.
 * 이 부품은 그 목록을 1분마다 읽어 안 읽은 수를 배지로 띄우고, 누르면 요약을 펼칩니다.
 * 사이트를 닫아 둔 동안에는 웹 푸시가 기기로 갑니다 — 이 패널 아래의 "기기 알림" 에서 켭니다.
 *
 * ─── 자리 ───────────────────────────────────────────────
 * 챗봇 단추 바로 왼쪽(좁은 화면에서는 위). 왼쪽 아래는 지도의 내 위치 · 반경 단추와, 화면 아래
 * 가운데는 이동 막대와 겹칩니다(app/globals.css 운영 알림 절). 패널이 열려 있는 동안은 챗봇 창을
 * CSS 로만 가립니다 — 챗봇을 내리면(useSuppressChatBot) 대화가 지워집니다.
 *
 * 관리자 여부는 화면을 그릴지만 정합니다. 목록 · 푸시 등록은 서버가 requireAdmin 으로 다시 봅니다.
 *
 * ─── 지우기 ─────────────────────────────────────────────
 * 알림마다 ✕, 머리에 "풀린 알림 지우기". 서버는 줄을 남기고 지운 시각만 찍습니다 — 같은 사건이
 * 계속 울리거나 풀려도 다시 뜨지 않고, 새로 울리면 다시 뜹니다 (db/migrate-082). 그래서 울리는
 * 중인 것을 지울 때만 묻고, 풀린 것은 바로 지웁니다.
 */

const POLL_MS = 60_000;

export default function OpsAlertBell() {
  const isAdmin = useIsAdmin();
  // 관리자가 아니면 아무것도 그리지 않고, 목록도 읽지 않습니다 (DESIGN-GUIDE §1-1 — "관리자만" 이라고도 알리지 않음)
  return isAdmin ? <Bell /> : null;
}

async function errorOf(res: Response, fallback: string): Promise<string> {
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return data.error ?? fallback;
}

function Bell() {
  const [data, setData] = useState<OpsAlertsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  /** 패널을 연 순간에 안 읽은 것이던 id — 읽음으로 바꾼 뒤에도 이번에는 "새 소식" 으로 보여 줍니다 */
  const [fresh, setFresh] = useState<ReadonlySet<number>>(new Set());
  /** 지우기가 실패한 까닭 · "풀린 알림 지우기" 를 보내는 중인지 */
  const [actionError, setActionError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const fabRef = useRef<HTMLButtonElement>(null);
  /** 늦게 온 응답이 새 응답을 덮어쓰지 않게 (components/LiveFeed.tsx 와 같은 방법) */
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const res = await fetch('/api/ops/alerts', { cache: 'no-store' });
      if (mine !== seq.current) return;
      if (!res.ok) {
        setLoadError(await errorOf(res, `알림을 불러오지 못했어요 (${res.status})`));
        return;
      }
      setData((await res.json()) as OpsAlertsResponse);
      setLoadError(null);
    } catch {
      if (mine === seq.current) setLoadError('연결이 잠깐 끊겼어요. 다시 시도해 주세요');
    }
  }, []);

  // 1분마다 — 화면이 숨어 있으면 쉬고, 다시 보이면 바로 한 번
  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  const openPanel = useCallback(() => {
    setOpen(true);
    void load();
  }, [load]);

  // 기기 알림을 눌러 들어온 경우 — 주소의 ?ops=open (새 창) 또는 서비스 워커의 메시지 (이미 열린 창)
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get(OPS_OPEN_PARAM) === 'open') {
      url.searchParams.delete(OPS_OPEN_PARAM);
      window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
      openPanel();
    }
    const sw = 'serviceWorker' in navigator ? navigator.serviceWorker : null;
    const onMessage = (e: MessageEvent) => {
      if ((e.data as { type?: string } | null)?.type === 'ops-open') openPanel();
    };
    sw?.addEventListener('message', onMessage);
    return () => sw?.removeEventListener('message', onMessage);
  }, [openPanel]);

  // 열면 안 읽은 것을 읽음으로 — 서버가 실패해도 다음 읽기에서 다시 맞춰집니다
  const unreadIds = data?.alerts.filter((a) => !a.read).map((a) => a.id).join(',') ?? '';
  useEffect(() => {
    if (!open || !unreadIds) return;
    setFresh((prev) => new Set([...prev, ...unreadIds.split(',').map(Number)]));
    void fetch('/api/ops/alerts/read', { method: 'PUT' }).then((res) => {
      if (res.ok) {
        setData((d) => d && { ...d, unread: 0, alerts: d.alerts.map((a) => ({ ...a, read: true })) });
      }
    });
  }, [open, unreadIds]);

  // 바깥을 누르거나 Esc 로 닫기 (components/EmoticonPicker.tsx 와 같은 방법)
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || fabRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        fabRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // 닫으면 "새 소식" 표시와 지우기 오류도 지웁니다 — 다음에 열 때는 그때 새로 온 것만
  useEffect(() => {
    if (!open) {
      setFresh(new Set());
      setActionError(null);
    }
  }, [open]);

  /** 목록에서 지우기 — 되면 화면에서 먼저 빼고, 다시 읽어 서버와 맞춥니다 */
  const dismiss = useCallback(
    async (query: string, gone: (a: OpsAlertView) => boolean): Promise<void> => {
      setActionError(null);
      try {
        const res = await fetch(`/api/ops/alerts?${query}`, { method: 'DELETE' });
        if (!res.ok) {
          setActionError(await errorOf(res, '알림을 지우지 못했어요. 다시 시도해 주세요'));
          return;
        }
        setData((d) => {
          if (!d) return d;
          const removedUnread = d.alerts.filter((a) => gone(a) && !a.read).length;
          return { ...d, alerts: d.alerts.filter((a) => !gone(a)), unread: Math.max(0, d.unread - removedUnread) };
        });
        // 지우기 전에 떠난 읽기가 늦게 와도 seq 가 앞서 있어 버려집니다
        void load();
      } catch {
        setActionError('연결이 잠깐 끊겼어요. 다시 시도해 주세요');
      }
    },
    [load],
  );

  const dismissOne = useCallback(
    async (a: OpsAlertView) => {
      if (
        a.status === 'firing' &&
        !window.confirm(
          `울리는 중인 '${a.alertname}' 알림을 목록에서 지울까요?\n` +
            '같은 알림이 계속 울리거나 풀려도 다시 띄우지 않아요. 새로 울리면 다시 떠요.',
        )
      ) {
        return;
      }
      await dismiss(`id=${a.id}`, (x) => x.id === a.id);
    },
    [dismiss],
  );

  const clearResolved = async () => {
    if (!window.confirm('풀린 알림을 모두 목록에서 지울까요? 울리는 중인 알림은 남아요.')) return;
    setClearing(true);
    await dismiss('status=resolved', (a) => a.status === 'resolved');
    setClearing(false);
  };

  const unread = data?.unread ?? 0;
  const hasResolved = data?.alerts.some((a) => a.status === 'resolved') ?? false;
  const firing = data?.alerts.some((a) => a.status === 'firing') ?? false;
  const unreadFiring = data?.alerts.some((a) => !a.read && a.status === 'firing') ?? false;
  const label = open ? '운영 알림 닫기' : unread ? `운영 알림 열기 — 새 소식 ${unread}건` : '운영 알림 열기';

  return (
    <>
      <button
        ref={fabRef}
        type="button"
        className={`ops-fab${open ? ' is-open' : ''}${firing ? ' is-firing' : ''}`}
        onClick={() => (open ? setOpen(false) : openPanel())}
        aria-label={label}
        title={label}
        aria-expanded={open}
      >
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
          <path
            d="M6 8.5a6 6 0 0 1 12 0c0 6.5 2.5 8.5 2.5 8.5h-17S6 15 6 8.5Z M10.2 20.5a2 2 0 0 0 3.6 0"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        {unread > 0 && (
          <span className={`ops-badge${unreadFiring ? '' : ' is-quiet'}`} aria-hidden="true">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <section ref={panelRef} className="ops-panel" role="dialog" aria-label="운영 알림">
          <header className="ops-head">
            <strong>운영 알림</strong>
            <div className="ops-head-actions">
              {hasResolved && (
                <button type="button" className="btn btn-sm" disabled={clearing} onClick={() => void clearResolved()}>
                  {clearing ? '지우는 중…' : '풀린 알림 지우기'}
                </button>
              )}
              <button type="button" className="btn btn-sm" onClick={() => setOpen(false)}>
                닫기
              </button>
            </div>
          </header>

          <div className="ops-body">
            {loadError && (
              <p className="warn" role="alert">
                {loadError}
              </p>
            )}
            {actionError && (
              <p className="warn" role="alert">
                {actionError}
              </p>
            )}
            {!data && !loadError && <p className="ops-empty">불러오는 중…</p>}
            {data && data.alerts.length === 0 && (
              <p className="ops-empty">
                아직 알림이 없어요. Grafana 가 문제를 찾으면 여기에 무슨 일인지와 먼저 볼 것을 정리해 드려요.
              </p>
            )}
            {data && data.alerts.length > 0 && (
              <ul className="ops-list">
                {data.alerts.map((a, i) => (
                  <AlertItem
                    key={a.id}
                    alert={a}
                    isNew={fresh.has(a.id)}
                    expanded={i === 0 && a.status === 'firing'}
                    onDismiss={dismissOne}
                  />
                ))}
              </ul>
            )}
          </div>

          <footer className="ops-foot">
            <PushToggle pushReady={data?.pushReady ?? false} />
            <TestButton onSent={() => {
              // 요약 · 푸시는 서버가 응답한 뒤에 하므로 조금 있다 다시 읽습니다
              setTimeout(() => void load(), 4000);
              setTimeout(() => void load(), 15000);
            }} />
          </footer>
        </section>
      )}
    </>
  );
}

function AlertItem({
  alert: a,
  isNew,
  expanded,
  onDismiss,
}: {
  alert: OpsAlertView;
  isNew: boolean;
  expanded: boolean;
  onDismiss: (a: OpsAlertView) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const firing = a.status === 'firing';
  const when = new Date(a.startsAt).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' });
  const remove = async () => {
    setBusy(true);
    await onDismiss(a);
    setBusy(false); // 지워졌으면 이 줄은 이미 사라졌고, 안 지웠으면(취소 · 실패) 다시 누를 수 있게
  };
  return (
    <li className={`ops-item${firing ? ' is-firing' : ' is-resolved'}${isNew ? ' is-new' : ''}`}>
      <div className="ops-item-head">
        <span className={`ops-status${firing ? ' is-firing' : ''}`}>{firing ? '울리는 중' : '풀림'}</span>
        <span className="ops-name">{a.alertname}</span>
        <time dateTime={a.startsAt} title={when}>
          {ago(a.startsAt)}
        </time>
        <button
          type="button"
          className="ops-dismiss"
          disabled={busy}
          onClick={() => void remove()}
          aria-label={`'${a.alertname}' 알림 지우기`}
          title="목록에서 지우기"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
            <path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <p className="ops-headline">{a.ai?.headline ?? a.summary ?? a.alertname}</p>
      {!firing && a.endsAt && <p className="ops-meta">{lasted(a.startsAt, a.endsAt)} 만에 풀렸어요</p>}

      {a.ai ? (
        <details className="ops-detail" open={expanded}>
          <summary>무슨 일인지 · 먼저 볼 것</summary>
          <p className="ops-impact">{a.ai.impact}</p>
          {a.ai.causes.length > 0 && (
            <>
              <p className="ops-sub">짐작되는 원인</p>
              <ul className="ops-causes">
                {a.ai.causes.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </>
          )}
          {a.ai.checks.length > 0 && (
            <>
              <p className="ops-sub">먼저 볼 것</p>
              <ol className="ops-checks">
                {a.ai.checks.map((c, i) => (
                  <CheckItem key={i} check={c} />
                ))}
              </ol>
            </>
          )}
          {a.summary && <p className="ops-meta">규칙 설명: {a.summary}</p>}
        </details>
      ) : a.aiError ? (
        <p className="ops-meta">{a.aiError}</p>
      ) : firing ? (
        <p className="ops-meta">요약을 만드는 중…</p>
      ) : null}

      {a.grafanaUrl && (
        <a className="ops-link" href={a.grafanaUrl} target="_blank" rel="noopener noreferrer">
          Grafana 에서 보기
        </a>
      )}
    </li>
  );
}

function CheckItem({ check }: { check: OpsAlertCheck }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!check.command) return;
    try {
      await navigator.clipboard.writeText(check.command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 복사를 막은 브라우저 — 명령은 화면에 그대로 있습니다 */
    }
  };
  return (
    <li>
      {check.what}
      {check.command && (
        <span className="ops-cmd">
          <code>{check.command}</code>
          <button type="button" className="btn btn-sm" onClick={() => void copy()} aria-label="명령 복사하기">
            {copied ? '복사함' : '복사'}
          </button>
        </span>
      )}
    </li>
  );
}

// ─── 기기 알림 (웹 푸시) ────────────────────────────────────
type PushState =
  | 'checking'
  | 'server-off' // 서버에 VAPID 키가 없음
  | 'ios-install' // 아이폰 · 아이패드 Safari 탭 — 홈 화면 앱에서만 됨
  | 'unsupported'
  | 'no-worker' // 서비스 워커가 없음 (개발 서버 · 등록 실패)
  | 'denied' // 브라우저에서 알림을 막음
  | 'off'
  | 'on';

function isIos(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent);
}

/** VAPID 공개 키(base64url) → subscribe 가 받는 바이트 */
function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const b64 = base64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function currentRegistration(): Promise<ServiceWorkerRegistration | null> {
  return (await navigator.serviceWorker.getRegistration()) ?? null;
}

function PushToggle({ pushReady }: { pushReady: boolean }) {
  const [state, setState] = useState<PushState>('checking');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async (): Promise<PushState> => {
      if (!pushReady) return 'server-off';
      const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
      if (!supported) return isIos() ? 'ios-install' : 'unsupported';
      const reg = await currentRegistration();
      if (!reg) return 'no-worker';
      if (Notification.permission === 'denied') return 'denied';
      return (await reg.pushManager.getSubscription()) ? 'on' : 'off';
    })()
      .then((s) => alive && setState(s))
      .catch(() => alive && setState('unsupported'));
    return () => {
      alive = false;
    };
  }, [pushReady]);

  const turnOn = async () => {
    setBusy(true);
    setError(null);
    try {
      // 권한 묻기는 반드시 누른 그 순간에 — iOS 는 다른 때 물으면 거절합니다
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setState(permission === 'denied' ? 'denied' : 'off');
        return;
      }
      const reg = await currentRegistration();
      if (!reg) {
        setState('no-worker');
        return;
      }
      const keyRes = await fetch('/api/ops/push', { cache: 'no-store' });
      if (!keyRes.ok) {
        setError(await errorOf(keyRes, '푸시 키를 받지 못했어요'));
        return;
      }
      const { publicKey } = (await keyRes.json()) as { publicKey: string };
      // 서버 키가 바뀌었으면 옛 구독으로는 받을 수 없어 먼저 지웁니다
      await (await reg.pushManager.getSubscription())?.unsubscribe();
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
      const res = await fetch('/api/ops/push', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sub.toJSON()),
      });
      if (!res.ok) {
        await sub.unsubscribe();
        setError(await errorOf(res, '이 기기를 등록하지 못했어요. 다시 시도해 주세요'));
        return;
      }
      setState('on');
    } catch {
      setError('기기 알림을 켜지 못했어요. 다시 시도해 주세요');
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async () => {
    setBusy(true);
    setError(null);
    try {
      const sub = await (await currentRegistration())?.pushManager.getSubscription();
      if (sub) {
        await fetch(`/api/ops/push?endpoint=${encodeURIComponent(sub.endpoint)}`, { method: 'DELETE' });
        await sub.unsubscribe();
      }
      setState('off');
    } catch {
      setError('기기 알림을 끄지 못했어요. 다시 시도해 주세요');
    } finally {
      setBusy(false);
    }
  };

  const note: Partial<Record<PushState, string>> = {
    checking: '기기 알림 상태를 보는 중…',
    'server-off': '서버에 푸시 키가 없어 기기 알림을 켤 수 없어요',
    'ios-install': '아이폰은 홈 화면에 추가한 앱에서 기기 알림을 켤 수 있어요',
    unsupported: '이 브라우저는 기기 알림을 받을 수 없어요',
    'no-worker': '운영 사이트(앱)에서 켤 수 있어요',
    denied: '브라우저 설정에서 이 사이트의 알림을 허용해 주세요',
  };

  return (
    <div className="ops-push">
      {state === 'on' || state === 'off' ? (
        <button
          type="button"
          className={`btn btn-sm${state === 'on' ? ' btn-on' : ''}`}
          disabled={busy}
          onClick={() => void (state === 'on' ? turnOff() : turnOn())}
          aria-pressed={state === 'on'}
        >
          {busy ? '바꾸는 중…' : state === 'on' ? '이 기기 알림 켜짐' : '이 기기로 알림 받기'}
        </button>
      ) : (
        <span className="ops-meta">{note[state]}</span>
      )}
      {error && (
        <span className="warn" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

function TestButton({ onSent }: { onSent: () => void }) {
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    setState('sending');
    setError(null);
    try {
      const res = await fetch('/api/ops/alerts/test', { method: 'POST' });
      if (!res.ok) {
        setError(await errorOf(res, '시험 알림을 보내지 못했어요'));
        setState('idle');
        return;
      }
      setState('sent');
      onSent();
      setTimeout(() => setState('idle'), 20000);
    } catch {
      setError('연결이 잠깐 끊겼어요. 다시 시도해 주세요');
      setState('idle');
    }
  };
  return (
    <div className="ops-test">
      <button type="button" className="btn btn-sm" disabled={state !== 'idle'} onClick={() => void send()}>
        {state === 'sending' ? '보내는 중…' : state === 'sent' ? '보냈어요' : '시험 알림'}
      </button>
      {error && (
        <span className="warn" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
