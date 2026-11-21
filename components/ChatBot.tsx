'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useChatSearch } from './ChatBotHost';
import { useSession } from '@/lib/use-session';
import { useVisualViewportBox } from '@/lib/use-visual-viewport';
import {
  RANK_LABELS,
  isReorderRequest,
  type ChatMessage,
  type ChatResponse,
  type ChatTurn,
} from '@/lib/chat-types';
import { canRetryWithoutConditions, formatOutcome } from '@/lib/chat-outcome';
import { describeChatFailure } from '@/lib/chat-failure';
import { isSearchRequest, refineConstraints, type BaseHint, type RefinedQuery } from '@/lib/chat-intent';
import {
  MAP_CENTER_NAME,
  currentPosition,
  locationGranted,
  mapCenter,
} from '@/lib/chat-location';
import { extractConstraints, type ChatConstraints, type MentionedPlace } from '@/lib/query-constraints';
import type { Machine } from '@/lib/types';
import {
  DEFAULT_ORDER,
  FACTORS,
  isCompleteOrder,
  type FactorKey,
  type PartialOrder,
  type PriorityOrder,
} from '@/lib/recommend';


/** 서버로 보낼 대화 기록의 최대 길이 (한 번 요청에 실리는 분량) */
const HISTORY_LIMIT = 12;

// 무엇을 적으면 되는지 첫 줄에서 보여 준다 — 예전에는 "오락실 찾아줘" 라는 정해진 말을
// 적어야만 찾아 줬고, 그 사실은 거절당한 뒤에야 알 수 있었다 (2026-10-26 베타 QA).
const GREETING = `무엇을 도와드릴까요? "홍대 사볼" 처럼 지역과 게임을 적으시면 바로 찾아 드려요.`;

/** 문장에서 아무것도 뽑지 못했을 때의 빈 제약 — 기준 위치 말('근처')만 따로 읽습니다 */
const EMPTY_CONSTRAINTS: ChatConstraints = {
  arcade: null,
  machineIds: [],
  machineNames: [],
  placeQuery: null,
  place: null,
};

/** 패널 안에서 Tab 으로 도는 것들 (C-3) */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

let seq = 0;
const nextId = (): string => `m${++seq}`;

/** 기준 위치를 정한 결과 — 내 위치 · 지도 가운데 · 없음 */
interface ResolvedBase {
  place: MentionedPlace | null;
  note?: string;
  /** 내 위치를 쓰지 못했다 — '내 위치에서 찾기' 단추를 붙인다 */
  offerLocate: boolean;
}

/**
 * 문장에 지역 · 오락실이 없을 때의 기준 위치 (2026-11-20 UX 시험 B-2 · B-3).
 *
 * **직전에 찾은 곳을 이어 쓰지 않습니다.** 예전에는 파인더가 붙잡아 둔 기준(앞 질문의 '홍대')
 * 으로 '근처 펌프' 를 찾았고, 말풍선에는 그 사실이 없었습니다. 순서는
 *   1. 내 위치 — '근처 · 우리 동네' 라고 했으면 권한을 물어서라도, 아니면 이미 허용된 때만
 *   2. 지금 지도 가운데 — 그렇게 찾았다고 적고 '내 위치에서 찾기' 단추를 붙입니다
 *   3. 둘 다 없으면 기준 없이 — 결과 말풍선이 그 사실을 적고 같은 단추를 붙입니다
 */
async function resolveBase(hint: BaseHint): Promise<ResolvedBase> {
  let reason: string | undefined;
  if (hint === 'near' || (await locationGranted())) {
    const mine = await currentPosition();
    if (mine.ok) return { place: mine.place, offerLocate: false };
    reason = mine.reason;
  }
  const center = mapCenter();
  if (center) {
    return {
      place: center,
      note: `${reason ? `${reason}. ` : ''}그래서 ${MAP_CENTER_NAME}를 기준으로 찾았어요.`,
      offerLocate: true,
    };
  }
  return { place: null, note: reason, offerLocate: true };
}

export default function ChatBot() {
  /*
    탐색 기능은 props 가 아니라 **파인더가 등록한 것**을 씁니다 (ChatBotHost.tsx).
    챗봇이 모든 화면에 떠 있어야 해서 레이아웃에 올렸는데, 순위 계산·지도 표시는
    파인더만 할 수 있기 때문입니다. 파인더가 아닌 화면에서는 null 입니다.
  */
  const search = useChatSearch();
  /**
   * 기다린 뒤(지역 찾기)에는 **그때의** 탐색 기능을 쓴다. 파인더는 목록이 바뀔 때마다
   * 새 함수를 등록하는데, 기다리기 전에 잡아 둔 함수는 옛 목록으로 순위를 매긴다.
   */
  const searchRef = useRef(search);
  useEffect(() => {
    searchRef.current = search;
  }, [search]);
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>(() => [
    { id: nextId(), role: 'assistant', text: GREETING },
  ]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);

  const panelRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /** 도우미를 여닫는 둥근 단추 — 닫으면 초점을 여기로 돌려준다 (C-3) */
  const fabRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLElement>(null);

  // 키보드가 올라와도 패널이 보이는 영역 안에 있게 (globals.css 의 .chat-panel[data-keyboard])
  useVisualViewportBox(panelRef, open);

  // 새 말풍선이 붙으면 항상 맨 아래를 보여 준다.
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, open]);

  // 열면 초점을 패널 안으로 옮긴다 — 안 그러면 낭독기는 무엇이 열렸는지 모른다 (C-3).
  // 터치 화면에서는 입력창 대신 제목으로 — 입력창에 주면 키보드가 패널보다 먼저 올라와
  // 인사말을 덮고, iOS 는 그 순간 화면을 밀어 올린다. 쓰려는 사람은 입력창을 누른다.
  useEffect(() => {
    if (!open) return;
    if (window.matchMedia('(pointer: coarse)').matches) titleRef.current?.focus();
    else inputRef.current?.focus();
  }, [open]);

  /** 닫고 초점을 연 단추로 돌려준다 — 초점이 body 로 떨어지면 키보드 사용자는 자리를 잃는다 */
  const close = useCallback(() => {
    setOpen(false);
    fabRef.current?.focus();
  }, []);

  /**
   * Esc 로 닫고, Tab 은 패널 안에서 돈다 (C-3). 패널은 화면 위에 떠 있어서 Tab 이 밖으로
   * 나가면 가려진 본문 어딘가로 초점이 사라진다. 밖으로 나가려면 Esc 나 닫기.
   */
  const onPanelKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLElement>) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
        return;
      }
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === titleRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [close],
  );

  /*
    파인더가 아닌 화면의 기종 사전. 파인더가 떠 있으면 그쪽 사전(search.extract)을 쓰지만,
    홈 · 커뮤니티 · 서열표에서는 사전이 없어 '홍대 사볼' 의 '사볼' 을 못 알아봤다 — 그래서
    로그인한 사람의 같은 문장이 모델로 가서 실패했다 (B-1). 패널을 열 때 한 번 받아 둔다.
  */
  const [dict, setDict] = useState<Machine[] | null>(null);
  useEffect(() => {
    if (!open || search || dict) return;
    let alive = true;
    fetch('/api/machines')
      .then((res) => (res.ok ? (res.json() as Promise<{ machines?: Machine[] }>) : null))
      .then((data) => {
        if (alive && data?.machines) setDict(data.machines);
      })
      .catch(() => {
        // 사전 없이도 '오락실 찾아줘' · '근처' 는 알아본다
      });
    return () => {
      alive = false;
    };
  }, [open, search, dict]);

  /** 문장 → 지역 · 기종 · 기준 위치 말 (lib/chat-intent.ts) */
  const readQuery = useCallback(
    (text: string): RefinedQuery => {
      const raw = search ? search.extract(text) : dict ? extractConstraints(text, [], dict) : EMPTY_CONSTRAINTS;
      return refineConstraints(text, raw);
    },
    [search, dict],
  );

  // ── 자유 질문 → 서버 ───────────────────────────────────────
  const ask = useCallback(
    async (history: ChatMessage[]) => {
      const pendingId = nextId();
      setMessages((prev) => [
        ...prev,
        { id: pendingId, role: 'assistant', text: '', pending: true },
      ]);
      setBusy(true);

      // 폼만 있고 내용이 없는 말풍선은 보내지 않는다 — 모델이 읽을 것이 없다.
      const turns: ChatTurn[] = history
        .filter((m) => m.text.trim() !== '' && !m.pending && !m.failed && !m.notice)
        .slice(-HISTORY_LIMIT)
        .map((m) => ({ role: m.role, text: m.text }));
      /** 이번에 보낸 문장 — 실패하면 입력창에 되돌리고 '다시 보내기' 에 쓴다 (B-4) */
      const asked = [...history].reverse().find((m) => m.role === 'user')?.text ?? '';

      // 파인더가 떠 있으면 기준 위치를 함께 보낸다 — "내 근처 사볼" 을 가까운 순으로 찾는 데 쓴다.
      // 다른 화면에서는 기준 위치가 없으므로 싣지 않고, 서버는 거리 없이 답한다.
      const origin = searchRef.current?.origin() ?? null;
      const near = origin ? { lat: origin.lat, lng: origin.lng } : undefined;

      let reply: ChatMessage;
      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ turns, near }),
        });
        const data = (await res.json().catch(() => ({}))) as Partial<ChatResponse> & { error?: string };
        const failure = !res.ok
          ? describeChatFailure(res.status, data.error)
          : data.unclear
            ? describeChatFailure('unclear')
            : null;
        reply = failure
          ? {
              id: pendingId,
              role: 'assistant',
              text: failure.text,
              failed: true,
              retryText: failure.retry ? asked : undefined,
              links:
                failure.cause === 'login'
                  ? [{ label: '로그인하기', href: `/login?next=${encodeURIComponent(pathname ?? '/')}` }]
                  : undefined,
            }
          : {
              id: pendingId,
              role: 'assistant',
              text: data.text ?? '',
              sources: data.sources,
              places: data.places,
            };
      } catch {
        const failure = describeChatFailure('network');
        reply = { id: pendingId, role: 'assistant', text: failure.text, failed: true, retryText: asked };
      }

      setMessages((prev) => prev.map((m) => (m.id === pendingId ? reply : m)));
      // 실패하면 보낸 문장을 입력창에 되돌린다 — 고쳐 보내거나 그대로 다시 보낼 수 있게.
      // 그 사이 새로 적은 게 있으면 덮지 않는다.
      if (reply.failed && asked) setInput((cur) => (cur.trim() === '' ? asked : cur));
      setBusy(false);
    },
    [pathname],
  );

  /** 실패한 자유 질문을 같은 문장으로 다시 보낸다 — 실패 말풍선은 지운다 */
  const resend = useCallback(
    (failedId: string, text: string) => {
      if (busy) return;
      const next = messages.filter((m) => m.id !== failedId);
      setMessages(next);
      setInput((cur) => (cur.trim() === text.trim() ? '' : cur));
      void ask(next);
    },
    [busy, messages, ask],
  );

  /**
   * 로그인 여부. 자유 질문(/api/chat)만 로그인이 필요하고, '오락실 찾아줘' 는
   * 브라우저에서 계산하므로 로그인 없이도 그대로 됩니다 (lib/recommend.ts).
   * 그 사실을 **보내기 전에** 말해 주려고 여기서 읽습니다 — 예전에는 질문을 다 쓰고
   * 보낸 뒤에야 401 로 알게 됐습니다 (2026-09-13 UX 점검).
   */
  const user = useSession();

  // ── 탐색 → 결과 말풍선 ─────────────────────────────────────
  /**
   * 탐색을 돌리고 결과 말풍선을 붙입니다. 바로 찾기 · 순서 폼 · '조건 풀고 다시 찾기' 가
   * 모두 이 길을 탑니다 — 그래야 어느 쪽으로 찾아도 결과 아래 같은 단추가 붙습니다.
   */
  const reportSearch = useCallback(
    (
      order: PriorityOrder,
      constraints: ChatConstraints | null,
      options?: { clearConditions?: boolean; note?: string; offerLocate?: boolean },
    ) => {
      const api = searchRef.current;
      if (!api) return;
      const outcome = api.onSearch(order, constraints, {
        clearConditions: options?.clearConditions,
      });
      const canClear = canRetryWithoutConditions(outcome, (constraints?.machineIds.length ?? 0) > 0);
      const text = formatOutcome(outcome, order, { canClear });
      // 기준 위치 없이 찾았거나 내 위치를 못 썼으면 '내 위치에서 찾기' 를 붙인다 (B-3).
      const offerLocate = options?.offerLocate === true || !outcome.hasOrigin;
      setMessages((prev) => [
        ...prev,
        {
          id: nextId(),
          role: 'assistant',
          text: options?.note ? `${options.note}\n\n${text}` : text,
          followUp: { order, constraints, canClear },
          locateRetry: offerLocate ? { ...(constraints ?? EMPTY_CONSTRAINTS), place: null } : undefined,
        },
      ]);
    },
    [],
  );

  /** 마지막으로 고른 순서, 없으면 DEFAULT_ORDER(거리 먼저) */
  const currentOrder = useCallback((): PriorityOrder => {
    const saved = searchRef.current?.initialOrder ?? [];
    return isCompleteOrder(saved) ? saved : DEFAULT_ORDER;
  }, []);

  /** 기다리는 동안의 '…' 말풍선. 돌려주는 함수로 지운다 */
  const showPending = useCallback(() => {
    const pendingId = nextId();
    setMessages((prev) => [...prev, { id: pendingId, role: 'assistant', text: '', pending: true }]);
    setBusy(true);
    return () => {
      setMessages((prev) => prev.filter((m) => m.id !== pendingId));
      setBusy(false);
    };
  }, []);

  /**
   * 문장 하나로 바로 찾습니다 — 1·2·3순위를 먼저 묻지 않습니다 (2026-10-26 베타 QA).
   *
   * 순서는 마지막으로 고른 것, 없으면 DEFAULT_ORDER(거리 먼저)입니다. 바꾸고 싶으면 결과 아래
   * '순서 바꾸기'.
   *
   * 기준 위치는 문장의 오락실 → 문장의 지역("홍대") → 내 위치 → 지도 가운데 순입니다
   * (resolveBase). 지역을 적었는데 못 찾으면 **엉뚱한 곳에서 찾지 않고 되묻습니다** (B-2).
   */
  const startSearch = useCallback(
    async (constraints: ChatConstraints, hint: BaseHint) => {
      const done = showPending();
      let place = constraints.place;
      let note: string | undefined;
      let offerLocate = false;
      if (constraints.arcade) {
        // 문장에 오락실을 짚었으면 그곳이 기준이다 (파인더 runSearch).
      } else if (constraints.placeQuery && !place) {
        const query = constraints.placeQuery;
        const found = (await searchRef.current?.locate(query)) ?? null;
        if (!found) {
          done();
          setMessages((prev) => [
            ...prev,
            {
              id: nextId(),
              role: 'assistant',
              text: `'${query}'가 어느 지역인지 모르겠어요. 역 이름이나 동 이름으로 다시 적어 주세요 (예: '홍대입구역 사볼'). 내 위치에서 찾으려면 아래 단추를 눌러 주세요.`,
              notice: true,
              locateRetry: { ...constraints, placeQuery: null, place: null },
            },
          ]);
          return;
        }
        // 지역 검색은 넓은 지명에 가게 하나를 돌려주기도 한다('강남' → '치보 신사점'). 좌표는 그
        // 동네 안이라 쓸 만하지만 이름만 적으면 엉뚱해 보이므로, 적은 말과 찾은 곳을 같이 적는다.
        place = {
          ...found,
          name: found.name.replace(/\s+/g, '') === query.replace(/\s+/g, '') ? found.name : `${query}(${found.name})`,
        };
      } else if (!place) {
        const base = await resolveBase(hint);
        place = base.place;
        note = base.note;
        offerLocate = base.offerLocate;
      }
      done();
      reportSearch(currentOrder(), { ...constraints, place }, { note, offerLocate });
    },
    [reportSearch, currentOrder, showPending],
  );

  /** '내 위치에서 찾기' — 같은 문장의 제약으로, 기준만 내 위치로 바꿔 다시 찾는다 (B-3) */
  const searchFromMyLocation = useCallback(
    async (constraints: ChatConstraints) => {
      const done = showPending();
      const mine = await currentPosition();
      done();
      if (!mine.ok) {
        setMessages((prev) => [
          ...prev,
          { id: nextId(), role: 'assistant', text: `${mine.reason}.`, failed: true },
        ]);
        return;
      }
      reportSearch(currentOrder(), { ...constraints, arcade: null, placeQuery: null, place: mine.place });
    },
    [reportSearch, currentOrder, showPending],
  );

  /**
   * 1·2·3순위 폼을 띄웁니다 — "우선순위" 라고 적었거나 결과 아래 '순서 바꾸기' 를 눌렀을 때.
   * 오락실 언급은 "지금 있는 곳" 으로 보고 기준 위치+제외에 쓰는데, 오인식일 수 있으므로
   * 폼에 보여 주고 끌 수 있게 합니다.
   */
  const openPriorityForm = useCallback((constraints: ChatConstraints | null) => {
    const machineNote = constraints?.machineIds.length
      ? `게임은 ${constraints.machineNames.join('·')}(으)로 좁힐게요. `
      : '';
    setMessages((prev) => [
      ...prev,
      {
        id: nextId(),
        role: 'assistant',
        text: `${machineNote}어떤 순서로 볼까요? 1·2·3순위를 골라 주세요.`,
        form: 'priority',
        constraints: constraints ?? undefined,
      },
    ]);
  }, []);

  /**
   * '내 즐겨찾기' · '찜한 곳' — 장소가 아니라 내 목록을 달라는 말입니다 (B-2).
   * 예전에는 상호 '즐겨찾기오락실' 을 기준으로 잡았습니다.
   */
  const showFavorites = useCallback(async () => {
    if (!user) {
      setMessages((prev) => [
        ...prev,
        {
          id: nextId(),
          role: 'assistant',
          text: '로그인하면 즐겨찾기한 오락실을 모아 보여 드려요.',
          notice: true,
          links: [{ label: '로그인하기', href: `/login?next=${encodeURIComponent(pathname ?? '/')}` }],
        },
      ]);
      return;
    }
    const done = showPending();
    let reply: ChatMessage;
    try {
      const res = await fetch('/api/favorites');
      if (!res.ok) throw new Error(String(res.status));
      const ids = ((await res.json()) as { arcadeIds?: number[] }).arcadeIds ?? [];
      if (ids.length === 0) {
        reply = {
          id: nextId(),
          role: 'assistant',
          text: '아직 즐겨찾기한 오락실이 없어요. 오락실을 열고 별 단추를 누르면 여기 모여요.',
          notice: true,
        };
      } else {
        const shown = ids.slice(0, 8);
        const names = await Promise.all(
          shown.map((id) =>
            fetch(`/api/arcades/${id}`)
              .then((r) => (r.ok ? (r.json() as Promise<{ arcade?: { name: string } }>) : null))
              .then((d) => ({ id, name: d?.arcade?.name ?? null }))
              .catch(() => ({ id, name: null })),
          ),
        );
        const known = names.filter((n): n is { id: number; name: string } => n.name !== null);
        const more = ids.length > shown.length ? ` 그중 ${shown.length}곳만 적었어요.` : '';
        reply = {
          id: nextId(),
          role: 'assistant',
          text: [
            `즐겨찾기한 오락실 ${ids.length}곳이에요.${more}`,
            ...(search ? known.map((n) => `- ${n.name}`) : []),
            search ? '파인더 목록에서도 맨 위에 보여요.' : '',
          ]
            .filter(Boolean)
            .join('\n'),
          // 파인더 밖에서는 눌러서 그 오락실로 간다. 파인더 안에서는 같은 화면 주소라 선택이
          // 바뀌지 않으므로 이름만 적는다 (목록 맨 위에 이미 있다).
          links: search ? undefined : known.map((n) => ({ label: n.name, href: `/finder?arcade=${n.id}` })),
        };
      }
    } catch {
      reply = {
        id: nextId(),
        role: 'assistant',
        text: '즐겨찾기를 불러오지 못했어요. 다시 시도해 주세요.',
        failed: true,
      };
    }
    done();
    setMessages((prev) => [...prev, reply]);
  }, [user, pathname, search, showPending]);

  /**
   * 오락실 찾기 한 줄 — 파인더에서만 돈다. 순서를 고르겠다고 했으면 폼, 아니면 바로 찾기.
   * 입력창 · 주소(?ask=) · 다른 화면에서 넘겨받은 문장(handoff)이 모두 이 길을 탄다.
   */
  const runFinderQuery = useCallback(
    (text: string, refined: RefinedQuery) => {
      // "우선순위 바꿀래" 처럼 순서를 직접 고르겠다고 한 때만 폼을 띄운다.
      if (isReorderRequest(text)) {
        openPriorityForm(refined.constraints);
        return;
      }
      // 문장을 버리지 않는다 — 언급된 기종·오락실·지역을 뽑아 탐색에 넘긴다.
      void startSearch(refined.constraints, refined.hint);
    },
    [openPriorityForm, startSearch],
  );

  /**
   * 다른 화면에서 받은 찾기 문장 — 파인더로 옮긴 뒤 파인더가 준비되면 이어서 찾는다 (B-1).
   * 예전에는 '파인더에서 찾기' 단추를 한 번 더 눌러야 했고, 로그인한 사람은 그 단추도 없이
   * 모델로 가서 실패했다.
   */
  const handoffRef = useRef<string | null>(null);

  // ── 보내기 ─────────────────────────────────────────────────
  /**
   * 한 줄을 실제로 처리합니다. 입력창과 **주소로 넘어온 질문**(?ask=)이 같은 경로를
   * 타야 답이 갈리지 않으므로 send 에서 떼어 두었습니다.
   */
  const submitText = useCallback((raw: string) => {
    const text = raw.trim();
    if (text === '' || busy) return;

    const userMsg: ChatMessage = { id: nextId(), role: 'user', text };
    const refined = readQuery(text);

    // '내 즐겨찾기' 는 찾기가 아니라 목록이다 — 로그인 여부와 화면에 상관없이 여기서 답한다.
    if (refined.hint === 'favorites') {
      setMessages((prev) => [...prev, userMsg]);
      void showFavorites();
      return;
    }

    // 탐색 요청인지는 **모델이 아니라 여기서** 가른다 (lib/chat-intent.ts).
    // 이 갈림길로 다음 화면이 정해지므로 매번 같은 판단이어야 하고, API 키가
    // 없어도 이 경로는 끝까지 굴러가야 한다. 로그인 여부로 갈리지 않는다 (B-1).
    if (isSearchRequest(text, refined, user !== null)) {
      setMessages((prev) => [...prev, userMsg]);
      if (search) {
        runFinderQuery(text, refined);
        return;
      }
      /*
        파인더가 떠 있지 않으면 여기서 탐색할 수 없습니다 — 순위를 매겨도 보여 줄 목록과
        지도가 없습니다. 단추를 한 번 더 누르게 하지 않고 바로 파인더로 옮겨서, 준비되면
        같은 문장으로 이어서 찾습니다 (아래 handoff 효과).
      */
      handoffRef.current = text;
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: 'assistant', text: '파인더 화면으로 옮겨서 찾을게요.', notice: true },
      ]);
      router.push('/finder');
      return;
    }

    // 자유 질문은 로그인이 필요하다. 서버까지 갔다가 401 을 받아 오는 대신 여기서
    // 답한다 — 결과가 같고, 기다림이 없고, 무엇보다 **입력창 위에 이미 적혀 있던
    // 말과 같은 말**이라 사용자가 두 번 놀라지 않는다. 잘못한 게 아니므로 빨간 상자로 그리지 않는다.
    if (!user) {
      setMessages((prev) => [
        ...prev,
        userMsg,
        {
          id: nextId(),
          role: 'assistant',
          text: "자유 질문은 로그인하면 답해 드려요. 오락실은 로그인 없이 바로 찾아 드려요 — '홍대 사볼' 처럼 지역과 게임을 적어 주세요.",
          notice: true,
          links: [{ label: '로그인하기', href: `/login?next=${encodeURIComponent(pathname ?? '/')}` }],
        },
      ]);
      return;
    }

    // setMessages 의 updater 안에서 ask() 를 부르면 안 된다 — updater 는 순수해야
    // 하고, StrictMode 는 그걸 확인하려고 두 번 호출한다. 그러면 요청이 두 번
    // 나가고 같은 답이 두 번 붙는다. 다음 목록을 여기서 만들어 넘긴다.
    const next = [...messages, userMsg];
    setMessages(next);
    void ask(next);
  }, [busy, ask, messages, user, search, readQuery, runFinderQuery, showFavorites, router, pathname]);

  const send = useCallback(() => {
    const text = input.trim();
    if (text === '' || busy) return;
    setInput('');
    submitText(text);
    // 보낸 뒤에도 초점은 입력창에 — 다음 질문을 바로 적고, 낭독기는 새 말풍선을 읽는다 (B-4).
    inputRef.current?.focus();
  }, [input, busy, submitText]);

  // 다른 화면에서 넘긴 찾기 문장을 파인더가 준비되면 이어서 찾는다 (B-1). 사용자 말풍선은
  // 이미 붙어 있으므로 다시 붙이지 않는다.
  useEffect(() => {
    const text = handoffRef.current;
    if (!text || !search?.ready) return;
    handoffRef.current = null;
    runFinderQuery(text, readQuery(text));
  }, [search, runFinderQuery, readQuery]);

  /**
   * 다른 화면에서 "오락실 찾아줘" 라고 한 사람을 이어받습니다 (주소로 넘어온 질문).
   *
   * 지금은 도우미가 직접 파인더로 옮기지만(handoff), 예전 링크 `/finder?ask=…` 도 그대로 받습니다.
   * 여기서 그 문장을 집어 **그대로 다시 넣어** 탐색까지 이어 갑니다.
   *
   * 한 번만 돕니다. submitText 는 대화가 바뀔 때마다 정체가 달라지므로 그대로 두면
   * 같은 질문이 반복해서 들어갑니다. 주소에서도 지웁니다 — 새로고침이 곧 재질문이
   * 되면 안 됩니다 (커뮤니티의 ?post= 와 같은 규칙).
   *
   * 파인더가 **기종 목록과 첫 오락실 목록을 받은 뒤**에 넣습니다(search.ready). 파인더는
   * 마운트하자마자 등록되는데, 그 순간 넣으면 기종 사전이 비어 있어 "노량진 근처에 사볼
   * 있는 오락실" 의 '사볼' 을 못 알아보고 기종 조건 없는 탐색이 됩니다 — 그러고도 아무
   * 말이 없어 사볼과 상관없는 곳이 1~3위로 나왔습니다 (2026-10-22 첫 사용자 점검).
   */
  const askedRef = useRef(false);
  useEffect(() => {
    if (askedRef.current || !search?.ready) return;
    const asked = new URLSearchParams(window.location.search).get('ask');
    if (!asked) return;
    askedRef.current = true;

    const url = new URL(window.location.href);
    url.searchParams.delete('ask');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}`);

    setOpen(true);
    submitText(asked);
  }, [search, submitText]);

  // ── 우선순위 제출 → 탐색 ───────────────────────────────────
  /**
   * 문장에 기준(오락실 · 지역 · 앞 결과의 기준 위치)이 없으면 여기서 정한다 — '우선순위로
   * 찾아줘' 가 위치를 허용해 두었는데도 기준 없이 매겨지던 것 (B-3).
   */
  const submitPriority = useCallback(
    async (formId: string, order: PriorityOrder, constraints: ChatConstraints | null) => {
      setMessages((prev) => prev.map((m) => (m.id === formId ? { ...m, formDone: true } : m)));
      if (constraints?.arcade || constraints?.place) {
        reportSearch(order, constraints);
        return;
      }
      const done = showPending();
      const base = await resolveBase(null);
      done();
      reportSearch(
        order,
        { ...(constraints ?? EMPTY_CONSTRAINTS), place: base.place },
        { note: base.note, offerLocate: base.offerLocate },
      );
    },
    [reportSearch, showPending],
  );

  /** "○○ 기준 · 제외" 를 켜고 끈다 — 추출이 오인식일 때의 탈출구 */
  const toggleConstraint = useCallback((formId: string, off: boolean) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === formId ? { ...m, constraintOff: off } : m)),
    );
  }, []);

  const loginHref = `/login?next=${encodeURIComponent(pathname ?? '/')}`;

  return (
    <>
      <button
        ref={fabRef}
        type="button"
        className={`chat-fab ${open ? 'is-open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && open) {
            e.stopPropagation();
            setOpen(false);
          }
        }}
        aria-label={open ? '도우미 닫기' : '도우미 열기'}
        title={open ? '도우미 닫기' : '도우미 열기'}
        aria-expanded={open}
        aria-controls={open ? 'chat-panel' : undefined}
      >
        {/* 그림 글자(이모지)는 기기마다 모양이 달라서 선 아이콘으로 그립니다 */}
        <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
          <path
            d={
              open
                ? 'M6 6l12 12M18 6 6 18'
                : 'M20 12.5c0 3.6-3.6 6.5-8 6.5-1 0-2-.15-2.9-.42L5 20l1.1-3.1A6.3 6.3 0 0 1 4 12.5C4 8.9 7.6 6 12 6s8 2.9 8 6.5Z'
            }
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open && (
        // 본문을 막지 않는 떠 있는 패널이라 aria-modal 은 false. 키보드는 Tab 이 안에서 돌고
        // Esc 로 나간다 (onPanelKeyDown).
        <section
          ref={panelRef}
          id="chat-panel"
          className="chat-panel"
          role="dialog"
          aria-modal="false"
          aria-labelledby="chat-title"
          onKeyDown={onPanelKeyDown}
        >
          <header className="chat-head">
            <strong id="chat-title" ref={titleRef} tabIndex={-1}>
              오락실 도우미
            </strong>
            <button type="button" className="btn btn-sm" onClick={close}>
              닫기
            </button>
          </header>

          {/* 새 말풍선을 낭독기가 읽게 — 실패는 role=alert 로 한 번 더 알린다 (B-4) */}
          <div className="chat-body" ref={bodyRef} role="log" aria-live="polite" aria-relevant="additions" aria-label="대화">
            {messages.map((m) => (
              <div key={m.id} className={`chat-msg chat-${m.role}`}>
                {m.pending ? (
                  <p className="chat-bubble chat-typing">
                    <i aria-hidden="true" />
                    <i aria-hidden="true" />
                    <i aria-hidden="true" />
                    <span className="sr-only">답을 만드는 중…</span>
                  </p>
                ) : (
                  <p className={`chat-bubble ${m.failed ? 'is-failed' : ''}`} role={m.failed ? 'alert' : undefined}>
                    {m.text}
                  </p>
                )}

                {m.places && m.places.length > 0 && (
                  // 답변에 나온 오락실의 길찾기 — 서버가 도구 결과에서 만든 링크만 답니다
                  // (모델이 적은 주소가 아닙니다). 상세 화면의 길찾기 단추와 같은 곳으로 갑니다.
                  <ul className="chat-sources">
                    {m.places.map((p) => (
                      <li key={p.directions}>
                        <a
                          href={p.directions}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="카카오맵 길찾기를 이 오락실을 목적지로 엽니다 (새 창)"
                        >
                          {p.name} 길찾기{p.distance ? ` · ${p.distance}` : ''}
                        </a>
                      </li>
                    ))}
                  </ul>
                )}

                {m.sources && m.sources.length > 0 && (
                  // 웹에서 실제로 읽은 문서만 답니다 (본문에서 URL 을 긁지 않습니다).
                  <ul className="chat-sources">
                    {m.sources.map((s) => (
                      <li key={s.url}>
                        <a href={s.url} target="_blank" rel="noopener noreferrer">
                          {s.title}
                        </a>
                      </li>
                    ))}
                  </ul>
                )}

                {m.links && m.links.length > 0 && (
                  <ul className="chat-sources">
                    {m.links.map((l) => (
                      <li key={l.href}>
                        <Link href={l.href} onClick={() => setOpen(false)}>
                          {l.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}

                {m.failed && m.retryText !== undefined && (
                  // 실패한 자유 질문 — 같은 문장으로 다시 보내거나, 모델 없이 되는 길로 간다 (B-4).
                  <div className="chat-follow-up">
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={busy}
                      onClick={() => resend(m.id, m.retryText!)}
                    >
                      다시 보내기
                    </button>
                    {!search && (
                      <Link className="btn btn-sm" href="/finder" onClick={() => setOpen(false)}>
                        파인더에서 찾기
                      </Link>
                    )}
                    <Link className="btn btn-sm" href="/tier" onClick={() => setOpen(false)}>
                      서열표에서 직접 찾기
                    </Link>
                  </div>
                )}

                {m.locateRetry && search && (
                  <div className="chat-follow-up">
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={busy}
                      onClick={() => void searchFromMyLocation(m.locateRetry!)}
                    >
                      내 위치에서 찾기
                    </button>
                  </div>
                )}

                {m.followUp && search && (
                  <div className="chat-follow-up">
                    {m.followUp.canClear && (
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={busy}
                        onClick={() =>
                          reportSearch(m.followUp!.order, m.followUp!.constraints, {
                            clearConditions: true,
                          })
                        }
                      >
                        조건 풀고 다시 찾기
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={busy}
                      onClick={() => openPriorityForm(m.followUp!.constraints)}
                    >
                      순서 바꾸기
                    </button>
                  </div>
                )}

                {m.goFinder && (
                  <Link
                    className="btn btn-primary btn-sm chat-go-finder"
                    href={`/finder?ask=${encodeURIComponent(m.goFinder)}`}
                    onClick={() => setOpen(false)}
                  >
                    파인더에서 찾기
                  </Link>
                )}

                {m.form === 'priority' && (
                  <>
                    {m.constraints?.arcade && (
                      <label className="chat-constraint">
                        <input
                          type="checkbox"
                          checked={m.constraintOff !== true}
                          disabled={m.formDone === true}
                          onChange={(e) => toggleConstraint(m.id, !e.target.checked)}
                        />
                        <span>
                          &apos;{m.constraints.arcade.name}&apos; 주변에서 찾고 그곳은 빼기
                        </span>
                      </label>
                    )}
                    <PriorityForm
                      initial={search?.initialOrder ?? []}
                      done={m.formDone === true}
                      onSubmit={(order) =>
                        void submitPriority(
                          m.id,
                          order,
                          m.constraints
                            ? // 체크를 끄면 오락실 제약만 빠진다 — 기종 제약은
                              // 문장에 적힌 그대로가 맞을 확률이 높다.
                              { ...m.constraints, arcade: m.constraintOff ? null : m.constraints.arcade }
                            : null,
                        )
                      }
                    />
                  </>
                )}
              </div>
            ))}
          </div>

          {!user && (
            <p className="chat-gate">
              자유 질문은{' '}
              <Link href={loginHref} onClick={() => setOpen(false)}>
                로그인
              </Link>
              하면 답해 드려요. <strong>오락실 찾기</strong>는 지금 바로 돼요.
            </p>
          )}

          <form
            className="chat-input"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            {/*
              기다리는 동안 disabled 로 막지 않는다 — 초점을 가진 칸이 disabled 가 되면 초점이
              body 로 떨어져 낭독기가 자리를 잃는다 (B-4). 읽기 전용으로 두고 보내기만 막는다.
            */}
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              aria-label="도우미에게 물어보기"
              placeholder={user ? '홍대 사볼 / 펌프 신곡 뭐 나왔어?' : '예: 홍대 근처 사볼'}
              maxLength={2000}
              readOnly={busy}
              aria-busy={busy}
            />
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !input.trim()}>
              보내기
            </button>
          </form>
        </section>
      )}
    </>
  );
}


/**
 * 1·2·3순위 드롭다운.
 *
 * 같은 항목을 두 칸에 넣을 수 없게 **이미 고른 것은 다른 칸에서 비활성**입니다.
 * 막지 않으면 "1순위 거리, 2순위 거리" 같은 입력을 받아 놓고 나중에 거절해야
 * 하는데, 고르는 중에 막는 쪽이 덜 성가십니다.
 *
 * 순위가 내부적으로 몇 점인지는 여기에 나오지 않습니다 (lib/recommend.ts
 * PRIORITY_POINTS). 사람이 답할 수 있는 건 "뭐가 더 중요한가" 까지입니다.
 */
function PriorityForm({
  initial,
  done,
  onSubmit,
}: {
  initial: PartialOrder;
  done: boolean;
  onSubmit: (order: PriorityOrder) => void;
}) {
  const [order, setOrder] = useState<PartialOrder>(() => [
    initial[0] ?? null,
    initial[1] ?? null,
    initial[2] ?? null,
  ]);

  const set = (rank: number, key: FactorKey | null) =>
    setOrder((prev) => prev.map((v, i) => (i === rank ? key : v)));

  const complete = isCompleteOrder(order);

  return (
    <div className={`chat-form ${done ? 'is-done' : ''}`}>
      {RANK_LABELS.map((label, rank) => (
        <label key={label} className="chat-rank">
          <span>{label}</span>
          <select
            value={order[rank] ?? ''}
            disabled={done}
            onChange={(e) => set(rank, (e.target.value || null) as FactorKey | null)}
          >
            <option value="">선택</option>
            {FACTORS.map((f) => (
              <option
                key={f.key}
                value={f.key}
                // 다른 칸이 이미 쓰고 있는 항목
                disabled={order.some((v, i) => i !== rank && v === f.key)}
              >
                {f.label}
              </option>
            ))}
          </select>
        </label>
      ))}

      <button
        type="button"
        className="btn btn-primary btn-sm"
        disabled={done || !complete}
        onClick={() => complete && onSubmit(order)}
      >
        {done ? '이 순서로 찾았어요' : '이 순서로 찾기'}
      </button>
    </div>
  );
}
