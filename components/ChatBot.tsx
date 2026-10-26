'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useChatSearch } from './ChatBotHost';
import { useSession } from '@/lib/use-session';
import { useVisualViewportBox } from '@/lib/use-visual-viewport';
import {
  RANK_LABELS,
  isArcadeSearchIntent,
  isReorderRequest,
  looksLikePlaceSearch,
  mentionsArcadeTopic,
  type ChatMessage,
  type ChatResponse,
  type ChatTurn,
} from '@/lib/chat-types';
import { canRetryWithoutConditions, formatOutcome } from '@/lib/chat-outcome';
import type { ChatConstraints } from '@/lib/query-constraints';
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
const GREETING = `무엇을 도와드릴까요? "홍대 사볼" 처럼 지역과 기종을 적으시면 바로 찾아 드려요.`;

let seq = 0;
const nextId = (): string => `m${++seq}`;

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
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>(() => [
    { id: nextId(), role: 'assistant', text: GREETING },
  ]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);

  const panelRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 키보드가 올라와도 패널이 보이는 영역 안에 있게 (globals.css 의 .chat-panel[data-keyboard])
  useVisualViewportBox(panelRef, open);

  // 새 말풍선이 붙으면 항상 맨 아래를 보여 준다.
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, open]);

  // 터치 화면에서는 열자마자 포커스를 주지 않는다 — 키보드가 패널보다 먼저 올라와
  // 인사말을 덮고, iOS 는 그 순간 화면을 밀어 올린다. 쓰려는 사람은 입력창을 누른다.
  useEffect(() => {
    if (open && !window.matchMedia('(pointer: coarse)').matches) inputRef.current?.focus();
  }, [open]);

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
        .filter((m) => m.text.trim() !== '' && !m.pending && !m.failed)
        .slice(-HISTORY_LIMIT)
        .map((m) => ({ role: m.role, text: m.text }));

      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ turns }),
        });
        const data = (await res.json()) as ChatResponse & { error?: string };

        setMessages((prev) =>
          prev.map((m) =>
            m.id === pendingId
              ? {
                  ...m,
                  pending: false,
                  failed: !res.ok,
                  text: res.ok ? data.text : (data.error ?? '답변을 만들지 못했습니다'),
                  sources: data.sources,
                }
              : m,
          ),
        );
      } catch {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === pendingId
              ? { ...m, pending: false, failed: true, text: '연결에 실패했습니다' }
              : m,
          ),
        );
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  /**
   * 로그인 여부. 자유 질문(/api/chat)만 로그인이 필요하고, '오락실 찾아줘' 는
   * 브라우저에서 계산하므로 로그인 없이도 그대로 됩니다 (lib/recommend.ts).
   * 그 사실을 **보내기 전에** 말해 주려고 여기서 읽습니다 — 예전에는 질문을 다 쓰고
   * 보낸 뒤에야 401 로 알게 됐습니다 (2026-09-13 UX 점검).
   */
  const user = useSession();

  // ── 보내기 ─────────────────────────────────────────────────
  /**
   * 한 줄을 실제로 처리합니다. 입력창과 **주소로 넘어온 질문**(?ask=)이 같은 경로를
   * 타야 답이 갈리지 않으므로 send 에서 떼어 두었습니다.
   */
  // ── 탐색 → 결과 말풍선 ─────────────────────────────────────
  /**
   * 탐색을 돌리고 결과 말풍선을 붙입니다. 바로 찾기 · 순서 폼 · '조건 풀고 다시 찾기' 가
   * 모두 이 길을 탑니다 — 그래야 어느 쪽으로 찾아도 결과 아래 같은 단추가 붙습니다.
   */
  const reportSearch = useCallback(
    (
      order: PriorityOrder,
      constraints: ChatConstraints | null,
      options?: { clearConditions?: boolean; note?: string },
    ) => {
      const api = searchRef.current;
      if (!api) return;
      const outcome = api.onSearch(order, constraints, {
        clearConditions: options?.clearConditions,
      });
      const canClear = canRetryWithoutConditions(outcome, (constraints?.machineIds.length ?? 0) > 0);
      const text = formatOutcome(outcome, order, { canClear });
      setMessages((prev) => [
        ...prev,
        {
          id: nextId(),
          role: 'assistant',
          text: options?.note ? `${options.note}\n\n${text}` : text,
          followUp: { order, constraints, canClear },
        },
      ]);
    },
    [],
  );

  /**
   * 문장 하나로 바로 찾습니다 — 1·2·3순위를 먼저 묻지 않습니다 (2026-10-26 베타 QA).
   *
   * 순서는 마지막으로 고른 것, 없으면 DEFAULT_ORDER(거리 먼저)입니다. 결과를 보기 전에 세 칸을
   * 다 고르게 하던 때는, 그중 둘(대기·컨디션)이 아직 제보가 거의 없어 고르는 의미가 없는데도
   * 세 칸을 채우기 전엔 단추가 켜지지 않았습니다. 바꾸고 싶으면 결과 아래 '순서 바꾸기'.
   *
   * 문장에 지역("홍대")이 있으면 먼저 좌표를 찾아 기준점으로 씁니다. 못 찾으면 그렇다고 적고
   * 지금 기준점으로 찾습니다 — 틀린 동네로 옮기느니 옮기지 않습니다.
   */
  const startSearch = useCallback(
    async (constraints: ChatConstraints) => {
      let place = constraints.place;
      let note: string | undefined;
      if (constraints.placeQuery && !place) {
        const pendingId = nextId();
        setMessages((prev) => [...prev, { id: pendingId, role: 'assistant', text: '', pending: true }]);
        setBusy(true);
        const query = constraints.placeQuery;
        const found = (await searchRef.current?.locate(query)) ?? null;
        setMessages((prev) => prev.filter((m) => m.id !== pendingId));
        setBusy(false);
        // 지역 검색은 넓은 지명에 가게 하나를 돌려주기도 한다('강남' → '치보 신사점'). 좌표는 그
        // 동네 안이라 쓸 만하지만 이름만 적으면 엉뚱해 보이므로, 적은 말과 찾은 곳을 같이 적는다.
        place = found && {
          ...found,
          name: found.name.replace(/\s+/g, '') === query.replace(/\s+/g, '') ? found.name : `${query}(${found.name})`,
        };
        if (!place) note = `'${query}' 를 지역으로 찾지 못해 지금 기준점으로 찾았습니다.`;
      }
      const saved = searchRef.current?.initialOrder ?? [];
      const order = isCompleteOrder(saved) ? saved : DEFAULT_ORDER;
      reportSearch(order, { ...constraints, place }, { note });
    },
    [reportSearch],
  );

  /**
   * 1·2·3순위 폼을 띄웁니다 — "우선순위" 라고 적었거나 결과 아래 '순서 바꾸기' 를 눌렀을 때.
   * 오락실 언급은 "지금 있는 곳" 으로 보고 기준점+제외에 쓰는데, 오인식일 수 있으므로
   * 폼에 보여 주고 끌 수 있게 합니다.
   */
  const openPriorityForm = useCallback((constraints: ChatConstraints | null) => {
    const hasConstraints =
      constraints !== null &&
      (constraints.arcade !== null || constraints.machineIds.length > 0 || constraints.place !== null);
    const machineNote = constraints?.machineIds.length
      ? `기종은 ${constraints.machineNames.join('·')}(으)로 좁힐게요. `
      : '';
    setMessages((prev) => [
      ...prev,
      {
        id: nextId(),
        role: 'assistant',
        text: `${machineNote}어떤 순서로 볼까요? 1·2·3순위를 골라 주세요.`,
        form: 'priority',
        constraints: hasConstraints ? constraints : undefined,
      },
    ]);
  }, []);

  const submitText = useCallback((raw: string) => {
    const text = raw.trim();
    if (text === '' || busy) return;

    const userMsg: ChatMessage = { id: nextId(), role: 'user', text };
    const constraints = search ? search.extract(text) : null;

    // 탐색 요청인지는 **모델이 아니라 여기서** 가른다 (lib/chat-types.ts).
    // 이 갈림길로 다음 화면이 정해지므로 매번 같은 판단이어야 하고, API 키가
    // 없어도 이 경로는 끝까지 굴러가야 한다.
    //
    // "홍대 사볼" 처럼 지역 + 기종만 적어도 찾아 달라는 말이다 (looksLikePlaceSearch).
    // 로그인하지 않은 사람은 자유 질문을 할 수 없으므로 그물을 더 넓힌다 — 오락실·기종
    // 이야기면 거절하지 않고 찾아 준다 (mentionsArcadeTopic).
    if (
      isArcadeSearchIntent(text) ||
      looksLikePlaceSearch(text, constraints) ||
      (!user && mentionsArcadeTopic(text, constraints))
    ) {
      /*
        파인더가 떠 있지 않으면 여기서 탐색할 수 없습니다 — 순위를 매겨도 보여 줄
        목록과 지도가 없습니다. 폼을 띄웠다가 "못 한다" 고 하는 대신, 할 수 있는
        곳으로 데려갑니다. 적은 문장은 버리지 않고 파인더 주소에 실어 보냅니다.
      */
      if (!search || !constraints) {
        setMessages((prev) => [
          ...prev,
          userMsg,
          {
            id: nextId(),
            role: 'assistant',
            text: '오락실 찾기는 파인더 화면에서 해 드려요. 아래 링크로 가시면 이어서 찾아 드립니다.',
            goFinder: text,
          },
        ]);
        return;
      }

      // "우선순위 바꿀래" 처럼 순서를 직접 고르겠다고 한 때만 폼을 띄운다.
      if (isReorderRequest(text)) {
        setMessages((prev) => [...prev, userMsg]);
        openPriorityForm(constraints);
        return;
      }

      // 문장을 버리지 않는다 — 언급된 기종·오락실·지역을 뽑아 탐색에 넘긴다.
      setMessages((prev) => [...prev, userMsg]);
      void startSearch(constraints);
      return;
    }

    // 자유 질문은 로그인이 필요하다. 서버까지 갔다가 401 을 받아 오는 대신 여기서
    // 답한다 — 결과가 같고, 기다림이 없고, 무엇보다 **입력창 위에 이미 적혀 있던
    // 말과 같은 말**이라 사용자가 두 번 놀라지 않는다.
    //
    // 파인더가 아닌 화면에서는 기종 사전이 없어 "홍대 사볼" 을 알아볼 수 없다. 거절로 끝내지
    // 않고 파인더로 가는 단추를 붙인다 — 그쪽에서 같은 문장으로 다시 찾는다.
    if (!user) {
      setMessages((prev) => [
        ...prev,
        userMsg,
        {
          id: nextId(),
          role: 'assistant',
          text: search
            ? '자유 질문은 로그인한 뒤에 답해 드릴 수 있어요. 오락실은 로그인 없이 찾아 드려요 — "홍대 사볼" 처럼 지역과 기종을 적어 주세요.'
            : '자유 질문은 로그인한 뒤에 답해 드릴 수 있어요. 오락실을 찾으려던 거라면 아래 단추로 파인더에서 이어서 찾아 드릴게요.',
          failed: true,
          goFinder: search ? undefined : text,
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
  }, [busy, ask, messages, user, search, startSearch, openPriorityForm]);

  const send = useCallback(() => {
    const text = input.trim();
    if (text === '' || busy) return;
    setInput('');
    submitText(text);
  }, [input, busy, submitText]);

  /**
   * 다른 화면에서 "오락실 찾아줘" 라고 한 사람을 이어받습니다.
   *
   * 그쪽 챗봇은 탐색을 못 해서 `/finder?ask=…` 링크로 보냅니다(위 goFinder). 여기서
   * 그 문장을 집어 **그대로 다시 넣어** 탐색까지 이어 갑니다 — 안 그러면 "이어서 찾아
   * 드립니다" 라고 해 놓고 빈 입력창을 보여 주게 됩니다.
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
  const submitPriority = useCallback(
    (formId: string, order: PriorityOrder, constraints: ChatConstraints | null) => {
      setMessages((prev) => prev.map((m) => (m.id === formId ? { ...m, formDone: true } : m)));
      reportSearch(order, constraints);
    },
    [reportSearch],
  );

  /** "○○ 기준 · 제외" 를 켜고 끈다 — 추출이 오인식일 때의 탈출구 */
  const toggleConstraint = useCallback((formId: string, off: boolean) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === formId ? { ...m, constraintOff: off } : m)),
    );
  }, []);

  return (
    <>
      <button
        type="button"
        className={`chat-fab ${open ? 'is-open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? '도우미 닫기' : '도우미 열기'}
        aria-expanded={open}
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
        <section ref={panelRef} className="chat-panel" role="dialog" aria-label="오락실 도우미">
          <header className="chat-head">
            <strong>오락실 도우미</strong>
            <button type="button" className="btn btn-sm" onClick={() => setOpen(false)}>
              닫기
            </button>
          </header>

          <div className="chat-body" ref={bodyRef}>
            {messages.map((m) => (
              <div key={m.id} className={`chat-msg chat-${m.role}`}>
                {m.pending ? (
                  <p className="chat-bubble chat-typing">
                    <i />
                    <i />
                    <i />
                  </p>
                ) : (
                  <p className={`chat-bubble ${m.failed ? 'is-failed' : ''}`}>{m.text}</p>
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
                          {m.constraints.arcade.name} 기준 · 결과에서 제외
                        </span>
                      </label>
                    )}
                    <PriorityForm
                      initial={search?.initialOrder ?? []}
                      done={m.formDone === true}
                      onSubmit={(order) =>
                        submitPriority(
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
              <Link href="/login?next=%2Ffinder" onClick={() => setOpen(false)}>
                로그인
              </Link>{' '}
              후에 답해 드려요. <strong>오락실 찾기</strong>는 로그인 없이도 됩니다.
            </p>
          )}

          <form
            className="chat-input"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={user ? '홍대 사볼 / 펌프 신곡 뭐 나왔어?' : '예: 홍대 근처 사볼'}
              maxLength={2000}
              disabled={busy}
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
        {done ? '탐색 완료' : '이 순서로 탐색'}
      </button>
    </div>
  );
}
