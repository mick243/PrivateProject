import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCommunityUrl, DEFAULT_LIST, parseCommunityUrl } from '@/app/community/community-url';
import {
  clearDraft,
  draftKey,
  DRAFT_TTL_MS,
  hasDraftContent,
  loadDraft,
  saveDraft,
  savedAgo,
} from '@/app/community/post-draft';
import { suspendConfirmText, suspendLabel, unsuspendConfirmText } from '@/lib/moderation-types';

/*
  2026-11-20 UX 시험의 커뮤니티 · 관리 항목 (C-1 주소 · M-1 임시 저장 · Ad-2/Ad-3 정지 확인 문구).
  화면 자체는 jsdom 테스트가 없어 순수 함수만 잰다.
*/

describe('커뮤니티 주소 (C-1)', () => {
  it('기본값은 주소에 적지 않는다', () => {
    expect(buildCommunityUrl(DEFAULT_LIST)).toBe('/community');
  });

  it('탭 · 말머리 · 정렬 · 검색어 · 쪽 · 글을 적고 그대로 되읽는다', () => {
    const list = { machineId: 3, category: 'tip', sort: 'popular' as const, q: ' 발판 ', page: 2 };
    const url = buildCommunityUrl(list, { kind: 'detail', postId: 24 });
    expect(url).toBe('/community?game=3&cat=tip&sort=popular&q=%EB%B0%9C%ED%8C%90&page=2&post=24');
    const back = parseCommunityUrl(url.slice(url.indexOf('?')));
    expect(back.list).toEqual({ machineId: 3, category: 'tip', sort: 'popular', q: '발판', page: 2 });
    expect(back.hasList).toBe(true);
    expect(back.target).toEqual({ kind: 'detail', postId: 24 });
  });

  it('?post= 만 있는 링크(관리자 원문 보기)는 목록 조건 없이 그 글', () => {
    expect(parseCommunityUrl('?post=24')).toEqual({ list: {}, hasList: false, target: { kind: 'detail', postId: 24 } });
  });

  it('글쓰기는 ?write=1', () => {
    expect(buildCommunityUrl(DEFAULT_LIST, { kind: 'write' })).toBe('/community?write=1');
    expect(parseCommunityUrl('?write=1').target).toEqual({ kind: 'write' });
  });

  it('사람이 고친 깨진 값은 없는 셈 친다', () => {
    const r = parseCommunityUrl('?game=abc&sort=nope&page=0&post=-1&q=%20%20');
    expect(r.list).toEqual({});
    expect(r.hasList).toBe(false);
    expect(r.target).toEqual({ kind: 'list' });
    expect(parseCommunityUrl('?page=99999999').list.page).toBeUndefined();
  });
});

describe('글쓰기 임시 저장 (M-1)', () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const draft = { machineId: 3 as const, category: 'free', title: '제목', body: '본문', bodyDoc: null };

  it('키는 계정 + 대상(새 글 · 고치는 글)', () => {
    expect(draftKey(7, null)).toBe('community:draft:7:new');
    expect(draftKey(7, 24)).toBe('community:draft:7:24');
  });

  it('적고 읽고 지운다', () => {
    const key = draftKey(7, null);
    saveDraft(key, draft, 1_000);
    expect(loadDraft(key, 2_000)).toEqual({ v: 1, ...draft, savedAt: 1_000 });
    clearDraft(key);
    expect(loadDraft(key)).toBeNull();
  });

  it('오래됐거나 모양이 깨진 것은 버린다', () => {
    const key = draftKey(7, null);
    saveDraft(key, draft, 0);
    expect(loadDraft(key, DRAFT_TTL_MS + 1)).toBeNull();
    expect(store.has(key)).toBe(false);
    store.set(key, '{"v":1,"title":3}');
    expect(loadDraft(key)).toBeNull();
    store.set(key, 'not json');
    expect(loadDraft(key)).toBeNull();
  });

  it('저장소가 던져도(시크릿 창 등) 글쓰기를 막지 않는다', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    });
    expect(() => saveDraft('k', draft)).not.toThrow();
    expect(loadDraft('k')).toBeNull();
    expect(() => clearDraft('k')).not.toThrow();
  });

  it('제목이나 본문이 있어야 남길 내용이 있다', () => {
    expect(hasDraftContent({ title: '  ', body: '' })).toBe(false);
    expect(hasDraftContent({ title: '', body: '[[img:3]]' })).toBe(true);
  });

  it('언제 쓰던 글인지', () => {
    expect(savedAgo(0, 30_000)).toBe('방금');
    expect(savedAgo(0, 5 * 60_000)).toBe('5분 전');
    expect(savedAgo(0, 3 * 3_600_000)).toBe('3시간 전');
    expect(savedAgo(0, 50 * 3_600_000)).toBe('2일 전');
  });
});

describe('계정 정지 확인 문구 (Ad-2 · Ad-3)', () => {
  it('기간과 사유를 담아 묻는다', () => {
    expect(suspendLabel(7)).toBe('7일');
    expect(suspendLabel(null)).toBe('무기한');
    const t = suspendConfirmText('발바닥', 7, '광고 도배');
    expect(t.startsWith('발바닥 님을 7일 정지할까요?')).toBe(true);
    expect(t).toContain('사유: 광고 도배');
    expect(suspendConfirmText('발바닥', null, 'x').startsWith('발바닥 님을 무기한 정지할까요?')).toBe(true);
  });

  it('풀기도 묻는다', () => {
    expect(unsuspendConfirmText('발바닥').startsWith('발바닥 님의 정지를 풀까요?')).toBe(true);
  });
});
