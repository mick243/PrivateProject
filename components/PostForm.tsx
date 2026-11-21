'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  clearDraft,
  draftKey,
  hasDraftContent,
  loadDraft,
  saveDraft,
  savedAgo,
  type PostDraft,
} from '@/app/community/post-draft';
import { attachmentIdsInBody, stripMarkers } from '@/lib/board-content';
import {
  defaultCategoryCode,
  isNotice,
  type Board,
  type BoardCategory,
  type PostDetail,
} from '@/lib/board-types';
import type { RichDoc } from '@/lib/rich-text';
import { usePlayerId } from '@/lib/use-player';
import { useIsAdmin } from '@/lib/use-session';
import RichTextEditor from './RichTextEditor';

/** 쓰는 중 임시 저장 간격 — 글자마다 localStorage 에 쓰지 않게 */
const DRAFT_SAVE_DELAY_MS = 600;

/** 취소할 때 묻는 말 (DESIGN-GUIDE §4 되돌릴 수 없는 확인) */
const DISCARD_CONFIRM = '쓰던 글을 버릴까요?\n제목 · 내용 · 넣은 사진이 사라지고 되돌릴 수 없어요.';

/** 글자도 첨부도 없으면 빈 본문. lib/validation.ts 의 서버 검증과 같은 규칙 */
function isBodyEmpty(body: string): boolean {
  return stripMarkers(body).trim().length === 0 && attachmentIdsInBody(body).length === 0;
}

interface Props {
  boards: Board[];
  categories: BoardCategory[];
  /** null 이면 새 글, 있으면 수정 */
  initial: PostDetail | null;
  /** 새 글일 때 어느 게임 탭에서 눌렀는지 */
  defaultMachineId: number | null;
  onCancel: () => void;
  onSaved: (post: PostDetail) => void;
}

export default function PostForm({
  boards,
  categories,
  initial,
  defaultMachineId,
  onCancel,
  onSaved,
}: Props) {
  const playerId = usePlayerId();
  const isAdmin = useIsAdmin();

  /**
   * 고른 게임. `''` = 고르지 않음 (공지에서만 허용).
   *
   * 수정 모드에서는 **글의 값을 그대로** 씁니다 — `initial.machineId ?? defaultMachineId`
   * 로 적으면 게임 없이 쓴 공지를 열었을 때 탭 기본값이 슬쩍 채워집니다.
   */
  const [machineId, setMachineId] = useState<number | ''>(
    initial ? (initial.machineId ?? '') : (defaultMachineId ?? ''),
  );
  /** 공지는 맨 앞 말머리지만 기본값이 아니다 (defaultCategoryCode 주석 참고) */
  const [category, setCategory] = useState(
    initial?.category ?? defaultCategoryCode(categories),
  );
  const [title, setTitle] = useState(initial?.title ?? '');
  /**
   * 편집기가 올려 주는 본문. 저장·검증에만 씁니다 — 편집기로 다시 내려보내면
   * 매 입력마다 캐럿이 튑니다 (RichTextEditor 주석 참고).
   *
   * `body` 는 평문(마커 포함)이고 `bodyDoc` 은 서식 있는 문서입니다. 서버는
   * 문서가 있으면 평문을 문서에서 다시 만들지만, 올리기 버튼을 언제 열지는 화면이
   * 판단해야 하므로 평문도 함께 들고 있습니다.
   */
  const [body, setBody] = useState(initial?.body ?? '');
  const [bodyDoc, setBodyDoc] = useState<RichDoc | null>(initial?.bodyDoc ?? null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  // ─── 임시 저장 · 떠나기 확인 (UX 시험 M-1) ─────────────────────
  //
  // 취소 · 새로고침 · 뒤로 가기에 쓰던 글이 확인 없이 사라졌다. 세 갈래로 막는다.
  //   ① 취소 — 바뀐 것이 있으면 '쓰던 글을 버릴까요?' 를 묻는다
  //   ② 새로고침 · 창 닫기 — beforeunload 로 브라우저가 묻게 한다
  //   ③ 뒤로 가기(화면 안 이동이라 ②가 안 걸린다) — 쓰는 동안 기기에 적어 두고, 다시 열면 '이어 쓰기' 를 권한다

  const key = playerId ? draftKey(playerId, initial?.id ?? null) : null;
  /** 처음 연 모습 — 이것과 다르면 '쓰던 글' 이다 */
  const baseline = useMemo(
    () => ({
      machineId: initial ? (initial.machineId ?? '') : (defaultMachineId ?? ''),
      category: initial?.category ?? defaultCategoryCode(categories),
      title: initial?.title ?? '',
      body: initial?.body ?? '',
      docJson: JSON.stringify(initial?.bodyDoc ?? null),
    }),
    // 처음 열 때의 값만 — 게시판 목록이 늦게 와도 기준이 움직이지 않게
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const dirty =
    machineId !== baseline.machineId ||
    category !== baseline.category ||
    title !== baseline.title ||
    body !== baseline.body ||
    (hasDraftContent({ title, body }) && JSON.stringify(bodyDoc) !== baseline.docJson);

  /** 이 기기에 남아 있던 쓰던 글 — 고를 때까지 새로 적지 않는다(덮어쓰지 않게) */
  const [offer, setOffer] = useState<PostDraft | null>(null);
  const [offerChecked, setOfferChecked] = useState(false);
  /** 편집기를 다시 만들 때 쓰는 값 — '이어 쓰기' 로 본문을 바꿀 때만 바뀐다 */
  const [seed, setSeed] = useState({ n: 0, doc: initial?.bodyDoc ?? null, body: initial?.body ?? '' });

  useEffect(() => {
    if (!key) return;
    const saved = loadDraft(key);
    if (
      saved &&
      hasDraftContent(saved) &&
      (saved.title !== baseline.title || saved.body !== baseline.body || saved.category !== baseline.category)
    ) {
      setOffer(saved);
    }
    setOfferChecked(true);
  }, [key, baseline]);

  const resume = () => {
    if (!offer) return;
    setMachineId(offer.machineId);
    setCategory(offer.category);
    setTitle(offer.title);
    setBody(offer.body);
    setBodyDoc(offer.bodyDoc);
    setSeed((prev) => ({ n: prev.n + 1, doc: offer.bodyDoc, body: offer.body }));
    setOffer(null);
  };
  const dropOffer = () => {
    if (key) clearDraft(key);
    setOffer(null);
  };

  /** 지금 값 — 화면을 떠나는 순간(언마운트)에 마지막으로 한 번 적는 데 쓴다 */
  const latest = useRef({ key, dirty, paused: true, draft: { machineId, category, title, body, bodyDoc } });
  latest.current = { key, dirty, paused: !offerChecked || offer !== null, draft: { machineId, category, title, body, bodyDoc } };

  useEffect(() => {
    if (!key || !offerChecked || offer !== null) return;
    const t = setTimeout(() => {
      if (dirty && hasDraftContent({ title, body })) saveDraft(key, { machineId, category, title, body, bodyDoc });
      else if (!dirty) clearDraft(key);
    }, DRAFT_SAVE_DELAY_MS);
    return () => clearTimeout(t);
  }, [key, offerChecked, offer, dirty, machineId, category, title, body, bodyDoc]);

  /** 저장했거나 버리기로 한 뒤에는 떠날 때 다시 적지 않는다 */
  const finished = useRef(false);
  useEffect(
    () => () => {
      const l = latest.current;
      if (finished.current || !l.key || l.paused || !l.dirty || !hasDraftContent(l.draft)) return;
      saveDraft(l.key, l.draft);
    },
    [],
  );

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // 옛 브라우저는 returnValue 가 있어야 묻는다 (문구는 브라우저가 정한다)
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const cancel = () => {
    if (dirty && !window.confirm(DISCARD_CONFIRM)) return;
    finished.current = true;
    if (key) clearDraft(key);
    onCancel();
  };

  /** 글쓰기를 열면 제목(h1)으로 초점을 옮긴다 — 화면이 바뀐 것을 낭독기가 알게 (C-3) */
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  const save = async () => {
    if (!playerId || (machineId === '' && !noticeSelected)) return;
    setBusy(true);
    setErrors([]);
    try {
      const res = await fetch(initial ? `/api/posts/${initial.id}` : '/api/posts', {
        method: initial ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        // imageIds 는 보내지 않는다 — 본문의 마커가 유일한 근거다 (lib/validation.ts)
        body: JSON.stringify({
          // 공지는 게임에 속하지 않는다 (아래 noticeSelected 주석). 서버도 같은
          // 판단을 다시 하지만, 화면이 보내는 값과 화면에 보이는 값이 같아야 한다.
          machineId: noticeSelected || machineId === '' ? null : machineId,
          category,
          title,
          body,
          bodyDoc,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrors(data.details ?? [data.error ?? '글을 저장하지 못했어요. 다시 시도해 주세요']);
        return;
      }
      finished.current = true;
      if (key) clearDraft(key);
      onSaved(data.post as PostDetail);
    } catch {
      setErrors(['연결이 잠깐 끊겼어요. 다시 시도해 주세요']);
    } finally {
      setBusy(false);
    }
  };

  /**
   * 고를 수 있는 말머리.
   *
   * '공지' 는 관리자에게만 보여 줍니다 — 커뮤니티 전체 맨 위에 고정되는 글이라
   * 아무나 올릴 수 있으면 고정 자리가 광고판이 됩니다. 여기서 감추는 것은 표시일
   * 뿐이고, 실제 판정은 세션 쿠키를 보는 서버가 합니다
   * (app/api/posts/notice-guard.ts) — 이 목록을 우회해 요청해도 403 입니다.
   *
   * 이미 고른 말머리는 권한과 무관하게 남깁니다. 관리자 세션이 만료된 채 공지를
   * 수정하는 경우, 칩이 사라지면 "아무것도 선택되지 않은 폼" 이 되어 무엇이
   * 잘못됐는지 알 수 없게 됩니다 (저장은 서버가 막습니다).
   */
  const pickable = categories.filter(
    (c) => !isNotice(c.code) || isAdmin || c.code === category,
  );

  /**
   * 공지를 고른 상태.
   *
   * 공지는 모든 게임 탭 맨 위에 붙는 글이라 어느 게시판에 썼는지가 뜻이 없어서,
   * 게임을 **고르지 않아도** 되고 골라도 저장하지 않습니다
   * (lib/validation.ts postInputSchema). 그래서 고를 수 없게 잠가 둡니다 —
   * 고를 수는 있는데 저장은 안 되는 칸이 더 헷갈립니다.
   */
  const noticeSelected = isNotice(category);

  /**
   * 주 버튼이 꺼져 있는 이유 — 첫 번째 하나만. 꺼진 버튼만 보여 주면 무엇을 채워야 하는지
   * 알 수 없습니다 (docs/DESIGN-GUIDE.md §1-3). 문구는 서버(lib/validation.ts)와 같게.
   */
  const missing =
    machineId === '' && !noticeSelected
      ? '게임을 골라 주세요'
      : title.trim().length < 2
        ? '제목을 2자 이상 써 주세요'
        : isBodyEmpty(body)
          ? '내용을 입력해 주세요'
          : null;

  return (
    <div className="post-form">
      {/*
        취소는 여기 한 곳만, 글자 링크로 둔다 (DESIGN-GUIDE §1-2). 예전에는 맨 아래
        저장 바에도 같은 무게의 '취소' 가 있어 할 일이 둘로 읽혔다 — 아래 바에는
        주 버튼 하나만 남긴다. 폼 맨 위라 쓰기 전에 마음을 바꾼 사람에게 가깝다.
      */}
      <header className="board-head">
        <h1 ref={headingRef} tabIndex={-1} className="post-form-title">
          {initial ? '글 수정' : '글쓰기'}
        </h1>
        <button type="button" className="btn-link" onClick={cancel}>
          취소
        </button>
      </header>

      {offer && (
        <div className="notice draft-offer" role="status">
          <span>
            {savedAgo(offer.savedAt)} 쓰던 글이 있어요{offer.title.trim() ? `: '${offer.title.trim()}'` : ''}.
          </span>
          <span className="draft-offer-actions">
            <button type="button" className="btn btn-sm" onClick={resume}>
              이어 쓰기
            </button>
            <button type="button" className="btn-link" onClick={dropOffer}>
              버리고 새로 쓰기
            </button>
          </span>
        </div>
      )}

      <div className="field">
        <label htmlFor="post-game">게임{noticeSelected && ' (공지는 고르지 않아요)'}</label>
        <select
          id="post-game"
          /* 공지일 때는 저장될 값(게임 없음)을 그대로 보여준다 — 화면과 저장물이
             어긋나지 않게. 말머리를 되돌리면 골라 둔 게임이 다시 나온다. */
          value={noticeSelected ? '' : machineId}
          disabled={busy || noticeSelected}
          onChange={(e) => setMachineId(e.target.value ? Number(e.target.value) : '')}
        >
          <option value="">{noticeSelected ? '게임 없음 (커뮤니티 전체)' : '게임 고르기'}</option>
          {boards.map((b) => (
            <option key={b.machineId} value={b.machineId}>
              {b.name}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label>말머리</label>
        <div className="chips">
          {pickable.map((c) => (
            <button
              key={c.code}
              type="button"
              className={category === c.code ? 'chip is-on' : 'chip'}
              disabled={busy}
              onClick={() => setCategory(c.code)}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <label htmlFor="post-title">제목</label>
        <input
          id="post-title"
          type="text"
          maxLength={120}
          value={title}
          disabled={busy}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>

      <div className="field">
        <label>내용</label>
        <RichTextEditor
          /* '이어 쓰기' 로 본문을 바꾸면 편집기를 새로 만든다 — 편집기는 처음 값만 받는다 */
          key={seed.n}
          initialDoc={seed.doc}
          initialBody={seed.body}
          initialAttachments={initial?.attachments ?? []}
          playerId={playerId}
          disabled={busy}
          onChange={({ doc, text }) => {
            setBodyDoc(doc);
            setBody(text);
          }}
        />
      </div>

      {errors.length > 0 && (
        <ul className="form-errors">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}

      <div className="form-actions">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          /* 첨부만 있는 글도 허용 — 그래서 글자 수가 아니라 "글자 또는 첨부" 를 본다 */
          disabled={busy || missing !== null}
          onClick={save}
        >
          {initial ? '고친 글 저장하기' : '글 올리기'}
        </button>
        {!busy && missing && <span className="muted small">{missing}</span>}
      </div>
    </div>
  );
}
