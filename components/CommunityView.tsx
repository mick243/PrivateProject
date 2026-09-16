'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  POPULAR_MIN_LIKES,
  POSTS_PAGE_SIZE,
  type Board,
  type BoardCategory,
  type PostDetail,
  type PostSort,
  type PostSummary,
} from '@/lib/board-types';
import { forgetPost, prefetchPost } from '@/lib/post-cache';
import { usePlayerId } from '@/lib/use-player';
import GameTabs from './GameTabs';
import Pagination from './Pagination';
import ScrollStrip from './ScrollStrip';
import PostDetailView from './PostDetailView';
/*
  글쓰기 화면은 **열 때 받습니다.**

  PostForm 은 Tiptap(에디터 본체 + 표 + 정렬 + ProseMirror)을 끌고 옵니다. 정적으로
  import 하면 글을 읽기만 하는 방문자도 그 번들을 내려받습니다 — 읽기와 쓰기의 비가
  54:1 인 서비스에서 대부분이 쓰지 않을 코드입니다 (2026-09-13 UX 점검).

  ssr:false 인 이유는 에디터가 브라우저 전용이기 때문입니다 (RichTextEditor 가
  immediatelyRender:false 로 같은 문제를 이미 다룹니다).
*/
const PostForm = dynamic(() => import('./PostForm'), {
  ssr: false,
  loading: () => <p className="muted pad">글쓰기 준비 중…</p>,
});
import PostList from './PostList';

/**
 * 커뮤니티 — 리듬게임별 탭.
 *
 * 탭은 리듬 기종 목록이고, '전체' 는 machineId 를 빼고 조회한 것입니다.
 * 저장 구조가 게임마다 갈리지 않으므로 게임이 늘어도 이 화면은 그대로입니다.
 */

/**
 * 검색어를 서버로 보내기까지 기다리는 시간. 한 글자마다 조회를 내보내면
 * '발판' 을 치는 동안 요청이 두 번 나가고, 늦게 온 첫 글자의 응답이 나중
 * 결과를 덮어쓸 수 있습니다. /live 피드와 같은 값입니다.
 */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * 열려 있는 화면. 목록 / 상세 / 작성·수정
 *
 * 상세는 목록에서 온 요약을 함께 들고 갑니다 — 상세가 응답을 기다리는 동안
 * 제목·글쓴이·시간·추천/댓글/조회 수를 먼저 그리는 데 씁니다. 글쓰기에서 저장한
 * 직후처럼 목록을 거치지 않고 들어오는 길에서는 없습니다(그때는 방금 쓴 내용을
 * 이미 알고 있으므로 서버 응답이 곧 옵니다).
 */
type View =
  | { kind: 'list' }
  | { kind: 'detail'; postId: number; summary?: PostSummary }
  | { kind: 'form'; post: PostDetail | null };

export default function CommunityView() {
  const playerId = usePlayerId();

  const [boards, setBoards] = useState<Board[]>([]);
  const [categories, setCategories] = useState<BoardCategory[]>([]);

  /** null = '전체' 탭 */
  const [machineId, setMachineId] = useState<number | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [sort, setSort] = useState<PostSort>('recent');
  /** 검색창에 지금 적혀 있는 값 / 실제로 조회에 쓰인 값 */
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  /** 1-based */
  const [page, setPage] = useState(1);

  const [posts, setPosts] = useState<PostSummary[]>([]);
  /** 목록 맨 위에 고정되는 공지. 게임 탭·말머리·정렬과 무관하게 서버가 골라 준다 */
  const [notices, setNotices] = useState<PostSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  /** 목록을 못 받았을 때의 문구. 500 응답의 undefined 가 PostList 에서 터지던 자리 */
  const [loadError, setLoadError] = useState<string | null>(null);

  const [view, setView] = useState<View>({ kind: 'list' });

  /**
   * 상세/글쓰기로 들어갈 때마다 히스토리를 한 칸 쌓는다 (URL 은 그대로, 상태만).
   * 그래서 브라우저 뒤로/앞으로가 오락실 파인더로 나가는 대신 이 화면 안의
   * 해당 단계로 오간다 — 탭·말머리·정렬은 그대로 list 로 setView 하는 것뿐이라
   * 건드리지 않은 채 남아 있다.
   *
   * history.state 에는 view 전체(글 내용 포함)를 넣지 않고 배열 인덱스만
   * 넣는다 — 실제 화면은 이 컴포넌트가 살아있는 동안 유지되는 viewsRef 에서
   * 인덱스로 찾는다. popstate 는 뒤/앞 어느 쪽이든 그 인덱스만 알려주므로
   * 방향을 따로 구분할 필요가 없다.
   *
   * ⚠ 처음 이 페이지로 들어올 때 만들어진 히스토리 엔트리(= idx 0)의
   * state 는 절대 replaceState 로 덮어쓰지 않는다. 그건 Next.js 라우터가
   * 자기 복원용으로 넣어둔 값이라, 덮으면 popstate 때 라우터가 그 페이지를
   * 통째로 다시 마운트해버려서(= machineId 같은 탭 선택이 초기화됨) 이 기능이
   * 고치려던 문제가 다른 모습으로 재발한다. idx 가 없는(undefined) 엔트리는
   * 그냥 0 으로 취급하면 된다 — 아래 popstate 핸들러가 이미 그렇게 한다.
   */
  const viewsRef = useRef<View[]>([{ kind: 'list' }]);
  const idxRef = useRef(0);

  const navigate = (next: View) => {
    const nextIdx = idxRef.current + 1;
    // 뒤로 갔다가 다른 곳으로 가면 그 앞에 있던 '앞으로' 기록은 브라우저의
    // 기본 동작과 같이 버린다.
    viewsRef.current = viewsRef.current.slice(0, nextIdx);
    viewsRef.current[nextIdx] = next;
    idxRef.current = nextIdx;
    window.history.pushState({ __idx: nextIdx }, '');
    setView(next);
  };

  /** 히스토리를 새로 쌓지 않고 현재 칸의 화면만 바꾼다 (글쓰기 → 상세로
   *  넘어가는 저장 직후처럼, 뒤로/앞으로 갔을 때 이 결과가 보여야 하는 경우). */
  const replaceCurrent = (next: View) => {
    viewsRef.current[idxRef.current] = next;
    setView(next);
  };

  /**
   * `/community?post=3` 으로 들어오면 그 글을 열어 둔 채로 시작한다 (홈 소식 배너가
   * 이 주소로 보낸다).
   *
   * 칸을 **쌓지 않고 0번 칸을 갈아끼운다**. 딥링크로 들어온 사람의 첫 칸이므로,
   * 쌓아 두면 뒤로가기 한 번이 빈 목록으로 갔다가 다시 나가야 사이트를 벗어난다 —
   * 눌린 횟수와 히스토리 깊이가 어긋난다 (ArcadeFinder 의 ?arcade=<id> 와 같은 규칙).
   *
   * 열고 나서 주소에서 지운다. 이 화면은 상세 상태를 주소에 계속 반영하지 않으므로
   * (pushState 의 __idx 로만 관리한다) 남겨 두면 목록으로 돌아간 뒤에도 주소가
   * `?post=3` 이라고 말하고, 새로고침하면 다시 그 글이 열린다.
   *
   * summary 없이 postId 만 넘긴다 — 상세가 알아서 받아 온다. 목록에서 누른 경우와
   * 달리 미리 들고 있는 요약이 없다.
   */
  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get('post');
    if (raw === null) return;
    const postId = Number(raw);
    if (!Number.isInteger(postId) || postId <= 0) return;

    replaceCurrent({ kind: 'detail', postId });
    const url = new URL(window.location.href);
    url.searchParams.delete('post');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}`);
    // 첫 마운트에서 한 번만 — 그 뒤의 이동은 navigate/goBack 이 맡는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 인앱 '뒤로가기'/'취소' 버튼도 브라우저 뒤로가기와 같은 한 걸음이어야
   *  history 깊이가 눈에 보이는 이동 횟수와 어긋나지 않는다. */
  const goBack = () => {
    if (idxRef.current > 0) {
      window.history.back();
    } else {
      setView({ kind: 'list' });
    }
  };

  useEffect(() => {
    fetch('/api/boards')
      .then((r) => r.json())
      .then((d) => {
        setBoards(d.boards as Board[]);
        setCategories(d.categories as BoardCategory[]);
      })
      .catch(() => undefined);
  }, []);

  /**
   * 검색어를 늦춰 반영하면서 **같은 틱에** 1페이지로 돌린다.
   *
   * 둘을 나누면(setPage 를 term 을 보는 별도 effect 로 빼면) 새 검색어와 옛
   * 페이지가 한 번 겹친 채로 조회가 나간다 — 3페이지에서 검색하면
   * `offset=40&q=…` 이 먼저 나가고, 그게 빈 응답으로 돌아오면 아래 loadPosts 의
   * '비면 한 페이지 물러난다' 가 이미 1페이지가 된 state 를 한 번 더 깎아
   * offset 을 음수로 만든다. 실제로 그랬다 (offset=-20 요청이 나갔다).
   *
   * 같은 타이머 안에서 둘을 부르면 React 가 한 번의 렌더로 묶으므로, 새 검색어는
   * 1페이지와만 짝지어 나간다. 페이지가 이미 1이면 setPage 는 아무 일도 안 한다.
   *
   * 탭·말머리는 이 문제가 없다 — 누르는 그 자리에서 resetPaging 을 같이 부르므로
   * 옛 페이지와 새 조건이 겹치는 순간이 없다.
   *
   * 첫 실행은 건너뛴다. 이 타이머는 화면이 열릴 때도 한 번 도는데(q 가 빈 값인
   * 채로), 그때까지 페이지를 되돌리면 목록이 뜨자마자 2페이지를 누른 사람이
   * 300ms 뒤에 이유 없이 1페이지로 끌려온다. 검색어가 바뀐 게 아니라 화면이
   * 열린 것이므로 되돌릴 이유가 없다.
   */
  const searchStarted = useRef(false);
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedQ(q);
      if (searchStarted.current) setPage(1);
      searchStarted.current = true;
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q]);

  /**
   * 검색 버튼 · 엔터 — 디바운스를 기다리지 않고 지금 조회한다. 위 타이머와
   * 같은 이유로 검색어와 페이지를 **한 번에** 되돌린다.
   *
   * 여기서는 searchStarted 를 보지 않는다. 위 타이머가 그걸 보는 것은 "화면이
   * 열려서 한 번 돈 것" 과 "검색어가 바뀐 것" 을 가리기 위한 것인데, 버튼을
   * 손으로 누른 것은 언제 눌렀든 검색이다 — 2페이지에서 눌렀다면 그 검색
   * 결과의 1페이지를 봐야 한다.
   *
   * 뜨고 있는 타이머는 굳이 끄지 않는다. 300ms 뒤에 같은 값으로 한 번 더
   * 불리지만 값이 같으면 React 가 리렌더를 건너뛴다.
   */
  const submitSearch = () => {
    setDebouncedQ(q);
    setPage(1);
    searchStarted.current = true;
  };

  /**
   * 지우기 — 화면의 값과 조회에 쓰인 값을 함께 비우고 1페이지로 돌린다.
   * setQ 만 하면 목록이 300ms 뒤에야 돌아와 "안 먹었다" 로 읽힌다.
   */
  const clearSearch = () => {
    setQ('');
    setDebouncedQ('');
    setPage(1);
    searchStarted.current = true;
  };

  /**
   * 조회에 실을 검색어. 공백만 적은 것은 검색이 아니다.
   *
   * loadPosts 의 의존성으로도 이 값을 쓴다 — debouncedQ 를 그대로 쓰면 뒤에
   * 공백 하나를 붙이는 것만으로 같은 결과를 다시 받아 온다.
   */
  const term = debouncedQ.trim();

  const loadPosts = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        sort,
        limit: String(POSTS_PAGE_SIZE),
        offset: String((page - 1) * POSTS_PAGE_SIZE),
      });
      if (machineId !== null) params.set('machineId', String(machineId));
      if (category !== null) params.set('category', category);
      if (term) params.set('q', term);

      const res = await fetch(`/api/posts?${params}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLoadError(data.error ?? `글 목록을 불러오지 못했습니다 (${res.status})`);
        return;
      }
      setLoadError(null);
      const list = (data.posts as PostSummary[]) ?? [];
      const count = (data.total as number) ?? 0;
      // 공지는 total 에 들어 있지 않다 — 페이지 수는 일반 글만으로 센다.
      setNotices((data.notices ?? []) as PostSummary[]);

      // 글이 지워져 현재 페이지가 비었으면 한 페이지 앞으로 물러난다.
      // (마지막 페이지의 마지막 글을 지운 경우)
      //
      // 조건은 이 조회가 나갈 때의 page(클로저)를 보는데 깎는 것은 **지금의**
      // page 다. 늦게 온 응답이면 그 둘이 다를 수 있으므로 updater 안에서 한 번
      // 더 막는다 — 1페이지를 깎으면 offset 이 음수가 된다.
      if (list.length === 0 && count > 0 && page > 1) {
        setPage((p) => (p > 1 ? p - 1 : p));
        return;
      }
      setPosts(list);
      setTotal(count);
    } catch {
      setLoadError('네트워크에 연결하지 못했습니다');
    } finally {
      setLoading(false);
    }
    // playerId 는 요청에 쓰이지 않지만 의존성에는 남깁니다 — 내 추천 여부를
    // 서버가 세션에서 읽으므로 로그인한 사람이 바뀌면 응답도 달라집니다
    // (TierBoardView 의 loadBoard 와 같은 이유).
  }, [machineId, category, sort, page, playerId, term]);

  useEffect(() => {
    void loadPosts();
  }, [loadPosts]);

  useEffect(() => {
    const onPopState = (e: PopStateEvent) => {
      const idx =
        e.state && typeof e.state.__idx === 'number' ? (e.state.__idx as number) : 0;
      idxRef.current = idx;
      const next = viewsRef.current[idx] ?? { kind: 'list' };
      setView(next);
      if (next.kind === 'list') void loadPosts(); // 추천·댓글 수가 바뀌었을 수 있다
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [loadPosts]);

  /** 탭·말머리·정렬을 바꾸면 1페이지부터 다시 본다 */
  const resetPaging = () => setPage(1);

  /** 목록이 시작되는 지점 (고정 공지 포함). 페이지를 넘길 때 여기로 올린다 */
  const listTopRef = useRef<HTMLDivElement>(null);

  /**
   * 페이지 이동 — 목록 첫 글이 화면 맨 위로 오게 스크롤합니다.
   *
   * 페이지 버튼은 목록 맨 아래에 있어서, 그냥 두면 다음 페이지도 **바닥부터**
   * 보입니다 — 사용자는 매번 손으로 맨 위까지 올려야 새 페이지를 읽을 수 있습니다.
   *
   * 새 글이 로드되기를 기다리지 않고 바로 올립니다. 목록의 위치 자체는 데이터와
   * 무관하게 그대로이므로 즉시 올려도 어긋나지 않고, 로드가 끝나면 그 자리의
   * 내용만 바뀝니다. 탭·말머리 변경(resetPaging)에는 걸지 않습니다 — 그건 이미
   * 필터 줄(목록 위)을 누른 뒤라 화면이 목록 근처에 있습니다.
   */
  const changePage = (next: number) => {
    setPage(next);
    listTopRef.current?.scrollIntoView({ block: 'start' });
  };

  /** 목록 → 상세. 요약을 함께 넘겨 상세가 **기다리지 않고** 그리게 한다 */
  const openPost = (post: PostSummary) =>
    navigate({ kind: 'detail', postId: post.id, summary: post });

  /**
   * 마우스 버튼을 누른 순간 — 상세가 어차피 보낼 요청을 여기서 시작한다.
   * 누르고 떼는 사이(보통 50~150ms)와 React 마운트 시간을 그만큼 번다.
   * 요청은 키별로 하나만 나가므로 상세가 다시 보내지 않는다 (lib/post-cache.ts).
   */
  const prefetchPostDetail = (postId: number) =>
    prefetchPost({ postId, playerId, commentOffset: 0 });

  /** 글이 새로 쓰이거나 지워지면 탭 글 수도 다시 읽는다 */
  const refreshBoards = () => {
    fetch('/api/boards')
      .then((r) => r.json())
      .then((d) => setBoards(d.boards as Board[]))
      .catch(() => undefined);
  };

  if (view.kind === 'form') {
    return (
      <div className="board-page">
        <PostForm
          boards={boards}
          categories={categories}
          initial={view.post}
          defaultMachineId={machineId ?? boards[0]?.machineId ?? null}
          onCancel={goBack}
          onSaved={(post) => {
            refreshBoards();
            // 고친 글의 옛 내용이 담겨 있으면 그것이 다시 보인다
            forgetPost(post.id);
            // 새 히스토리를 쌓지 않고 폼이 있던 칸을 상세로 바꾼다 — 그래야
            // 나중에 앞으로가기를 눌러도 사라진 글쓰기 폼이 아니라 이 상세가 나온다.
            replaceCurrent({ kind: 'detail', postId: post.id });
          }}
        />
      </div>
    );
  }


  /**
   * 상세일 때는 목록을 반환에서 뺀다 (예전과 같다).
   *
   * 감춰 두는 쪽(hidden)도 해 보고 재 봤지만 얻는 것이 없었다 — 목록 데이터는
   * 이 컴포넌트의 state 라 언마운트되지 않고, 뒤로가기는 이미 9ms 에 스피너 없이
   * 그려지며(측정), 스크롤 위치도 브라우저가 popstate 에서 복원한다. 상세를 열 때
   * 보내는 목록 재조회도 양쪽이 똑같이 한 번이다.
   */
  if (view.kind === 'detail') {
    return (
      <div className="board-page">
        <PostDetailView
          postId={view.postId}
          initial={view.summary ?? null}
          onBack={goBack}
          onEdit={(post) => navigate({ kind: 'form', post })}
          onDeleted={() => {
            refreshBoards();
            goBack();
          }}
        />
      </div>
    );
  }

  return (
    <div className="board-page">
      <header className="board-head">
        <div>
          <h1>커뮤니티</h1>
          <p className="muted small">
            리듬게임별 게시판입니다. 오락실 정보 · 공략 · 질문을 게임 단위로 모읍니다.
          </p>
        </div>
        {/*
          비로그인에는 **비활성 버튼 대신 로그인 링크**를 둔다. 예전에는 회색으로
          눌리지 않는 버튼이었고, 이유는 title 툴팁에만 있었다 — 폰에는 툴팁이 없어
          "눌러도 아무 일이 없는 버튼" 이었다 (2026-09-13 UX 점검).
          돌아올 곳(next)을 들려 보내 로그인 뒤 이 화면으로 되돌아온다.
        */}
        {playerId ? (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => navigate({ kind: 'form', post: null })}
          >
            글쓰기
          </button>
        ) : (
          <Link className="btn btn-primary btn-sm" href="/login?next=%2Fcommunity">
            로그인하고 글쓰기
          </Link>
        )}
      </header>

      {/* ── 게임 탭 ──
          한 줄로 두고 옆으로 스크롤한다 — 넘치면 화살표가 붙는다 (GameTabs.tsx) */}
      <GameTabs
        boards={boards}
        machineId={machineId}
        onSelect={(id) => {
          setMachineId(id);
          resetPaging();
        }}
      />

      {/* ── 검색 ──
          게임 탭 **아래**에 둔다 — 탭이 검색 범위이므로(사볼 탭에서 찾으면 사볼
          글만 나온다) 범위가 먼저 보이고 검색어가 그 다음이어야 읽는 순서가
          맞다. 말머리·정렬 줄과 한 줄에 합치지 않는 이유: 말머리 칩이 기종
          수만큼 늘어나는 줄이라, 거기에 입력창을 끼우면 좁은 화면에서 검색창이
          칩 사이 어딘가로 밀려간다. */}
      {/* <form> 인 이유는 엔터다 (components/LiveFeed.tsx 의 같은 줄 주석 참고) */}
      <form className="list-search" onSubmit={(e) => { e.preventDefault(); submitSearch(); }}>
        <input
          className="search"
          type="search"
          aria-label="글 검색"
          placeholder="제목 · 본문 검색"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button type="submit" className="btn btn-sm btn-primary">
          검색
        </button>
        {/* 값이 없을 때 감추지 않고 끄는 이유는 아래 건수 칸과 같다 — 나타나고
            사라지면 그 칸이 밀려서 글자를 치는 중에 줄이 흔들린다. */}
        <button type="button" className="btn btn-sm" disabled={q === ''} onClick={clearSearch}>
          지우기
        </button>
        {/* 몇 건인지는 검색 중에만 뜻이 있다 — 평소의 전체 글 수는 페이지
            버튼이 이미 말해 준다. loading 중에 옛 total 을 그대로 보여주면
            직전 검색어의 건수가 새 검색어 옆에 붙으므로 문구로 바꿔 둔다. */}
        {term !== '' && (
          <span className="list-search-count muted small">
            {loading ? '찾는 중…' : `${total.toLocaleString('ko-KR')}건`}
          </span>
        )}
      </form>

      {/* ── 말머리 · 정렬 ── */}
      <div className="board-filters">
        {/* 말머리도 게임 탭과 같이 한 줄로 두고 옆으로 민다 (components/ScrollStrip.tsx).
            게임 탭과 달리 오른쪽에 정렬 버튼이 같이 서 있어서, 밀리는 것은 이 칩 줄만이고
            정렬 버튼은 줄 끝에 남는다 (app/globals.css 의 .board-filters). */}
        <ScrollStrip
          className="chips"
          remeasureKey={categories.length}
          /* 하나만 고르는 줄이라 되돌아왔을 때 고른 말머리가 보여야 한다 —
             상세를 열면 이 화면이 통째로 사라졌다 다시 붙으면서 스크롤이 0 이 된다. */
          revealKey={category ?? 'all'}
        >
          <button
            type="button"
            className={category === null ? 'chip is-on' : 'chip'}
            onClick={() => {
              setCategory(null);
              resetPaging();
            }}
          >
            전체
          </button>
          {categories.map((c) => (
            <button
              key={c.code}
              type="button"
              className={category === c.code ? 'chip is-on' : 'chip'}
              onClick={() => {
                setCategory(c.code);
                resetPaging();
              }}
            >
              {c.label}
            </button>
          ))}
        </ScrollStrip>

        {/* 인기글은 말머리와 다른 축(정렬)이라 같은 줄 오른쪽 끝에 따로 세운다.
            누르면 인기순, 다시 누르면 기본값인 최신순 — 정렬 버튼이 이것뿐이므로
            최신순으로 돌아갈 길도 이 버튼이 겸한다.
            기준(추천 N개)은 눌러 보기 전에는 알 수 없으므로 title 로 미리 알린다. */}
        <button
          type="button"
          className={sort === 'popular' ? 'board-sort is-on' : 'board-sort'}
          aria-pressed={sort === 'popular'}
          title={`추천 ${POPULAR_MIN_LIKES}개 이상 받은 글만`}
          onClick={() => {
            setSort(sort === 'popular' ? 'recent' : 'popular');
            resetPaging();
          }}
        >
          인기글
        </button>
      </div>

      <div ref={listTopRef} />
      {loadError && (
        <p className="warn pad" role="alert">
          {loadError}
        </p>
      )}
      <PostList
        posts={posts}
        notices={notices}
        loading={loading}
        total={total}
        /* '전체' 탭에서만 어느 게임 글인지 보여준다 — 게임 탭에서는 전부 같은 값이라 잡음이다 */
        showGame={machineId === null}
        popularOnly={sort === 'popular'}
        /* 목록이 비었을 때 "첫 글을 남겨 보세요" 가 아니라 "검색 결과가 없습니다"
           라고 해야 한다 — 글은 있고, 찾는 말이 없을 뿐이다 */
        searching={term !== ''}
        onOpen={openPost}
        onPrefetch={prefetchPostDetail}
      />

      <Pagination
        page={page}
        total={total}
        pageSize={POSTS_PAGE_SIZE}
        onChange={changePage}
      />
    </div>
  );
}
