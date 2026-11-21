import type { RichDoc } from '@/lib/rich-text';

/**
 * 글쓰기 임시 저장 — 이 기기(localStorage)에만.
 *
 * 2026-11-20 UX 시험 M-1: 글쓰기에서 취소 · 새로고침 · 뒤로 가기를 누르면 제목 · 본문 · 사진이 확인 없이
 * 사라졌다. 쓰는 동안 여기에 적어 두고, 다시 글쓰기를 열면 '이어 쓰기' 를 권한다. 올리기에 성공하면 지운다.
 *
 * 키는 **계정 + 대상**(새 글 · 고치는 글 번호)이다. 새 글을 게시판(게임)마다 나누지 않은 이유: 게임은
 * 폼 안에서 고르는 칸이라, 사볼 탭에서 쓰다 펌프 탭에서 글쓰기를 다시 열면 이어 쓸 수 없게 된다.
 * 고른 게임은 임시 저장 안에 들어 있다.
 *
 * 사진은 올릴 때 이미 서버에 올라가 있으므로 본문 문서에 든 첨부 번호만 적는다.
 * localStorage 는 시크릿 창 · 저장 공간 초과 · 막힌 사이트 데이터에서 던질 수 있어 전부 try/catch 다.
 */

export interface PostDraft {
  v: 1;
  machineId: number | '';
  category: string;
  title: string;
  body: string;
  bodyDoc: RichDoc | null;
  /** epoch ms */
  savedAt: number;
}

/** 이보다 오래된 임시 저장은 권하지 않고 지운다 */
export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function draftKey(playerId: number, editingPostId: number | null): string {
  return `community:draft:${playerId}:${editingPostId ?? 'new'}`;
}

function isDraft(v: unknown): v is PostDraft {
  if (!v || typeof v !== 'object') return false;
  const d = v as Record<string, unknown>;
  return (
    d.v === 1 &&
    (d.machineId === '' || (typeof d.machineId === 'number' && Number.isInteger(d.machineId))) &&
    typeof d.category === 'string' &&
    typeof d.title === 'string' &&
    typeof d.body === 'string' &&
    (d.bodyDoc === null || (typeof d.bodyDoc === 'object' && !Array.isArray(d.bodyDoc))) &&
    typeof d.savedAt === 'number'
  );
}

export function loadDraft(key: string, now = Date.now()): PostDraft | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isDraft(parsed) || now - parsed.savedAt > DRAFT_TTL_MS) {
      localStorage.removeItem(key);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function saveDraft(key: string, draft: Omit<PostDraft, 'v' | 'savedAt'>, now = Date.now()): void {
  try {
    localStorage.setItem(key, JSON.stringify({ v: 1, ...draft, savedAt: now } satisfies PostDraft));
  } catch {
    // 저장이 막혀도 글쓰기는 그대로 된다 — 떠날 때 묻는 확인창이 남은 안전망이다
  }
}

export function clearDraft(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // 위와 같음
  }
}

/** 임시 저장에 남길 만한 내용이 있나 — 제목이나 본문(글자 · 첨부)이 있어야 한다 */
export function hasDraftContent(d: Pick<PostDraft, 'title' | 'body'>): boolean {
  return d.title.trim().length > 0 || d.body.trim().length > 0;
}

/** '방금' · '5분 전' · '3시간 전' · '2일 전' */
export function savedAgo(savedAt: number, now = Date.now()): string {
  const min = Math.floor((now - savedAt) / 60_000);
  if (min < 1) return '방금';
  if (min < 60) return `${min}분 전`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}
