import { describe, expect, it } from 'vitest';
import {
  EMOTICON_IMAGES_PER_REVIEW,
  prepareReviewParts,
  REVIEW_SUMMARY_KEYS,
  REVIEW_SUMMARY_MIN,
} from '@/lib/review-summary-types';

/**
 * 리뷰를 모델에 넣을 조각으로 바꾸는 규칙.
 *
 * 모델 호출은 시험하지 않습니다 — 그쪽은 열쇠와 네트워크가 필요하고 답이 매번
 * 다릅니다. 여기서 못 박는 것은 **무엇을 보내고 무엇을 보내지 않는가**입니다.
 * 마커 `[[emo:N]]` 이 그대로 새면 요약에 "emo 12" 가 튀어나오고, 이모티콘만 있는
 * 리뷰를 글로만 보내면 모델은 그 리뷰가 무슨 뜻인지 알 길이 없습니다.
 */

const names = new Map<number, string>([
  [12, '박수'],
  [7, '울음'],
]);

describe('prepareReviewParts', () => {
  it('글만 있는 리뷰는 별점과 함께 한 줄', () => {
    const parts = prepareReviewParts([{ rating: 4, body: '센서가 좋아요' }], names);
    expect(parts).toEqual([{ kind: 'text', text: '리뷰 1 · 별점 4/5 · 센서가 좋아요' }]);
  });

  it('본문이 없으면 "본문 없음" — 별점만 있는 리뷰도 의견입니다', () => {
    expect(prepareReviewParts([{ rating: 2, body: null }], names)).toEqual([
      { kind: 'text', text: '리뷰 1 · 별점 2/5 · 본문 없음' },
    ]);
    expect(prepareReviewParts([{ rating: 2, body: '   ' }], names)[0]).toEqual({
      kind: 'text',
      text: '리뷰 1 · 별점 2/5 · 본문 없음',
    });
  });

  it('글과 이모티콘이 섞이면 마커를 이름으로 바꾼다 — 마커가 새지 않는다', () => {
    const [part] = prepareReviewParts([{ rating: 5, body: '최고 [[emo:12]] 또 올게요' }], names);
    expect(part).toEqual({ kind: 'text', text: '리뷰 1 · 별점 5/5 · 최고 (이모티콘: 박수) 또 올게요' });
    expect(JSON.stringify(part)).not.toContain('[[emo:');
  });

  it('이름을 모르는(지워진) 이모티콘은 (이모티콘) 으로만', () => {
    const [part] = prepareReviewParts([{ rating: 3, body: '음 [[emo:999]]' }], names);
    expect(part).toEqual({ kind: 'text', text: '리뷰 1 · 별점 3/5 · 음 (이모티콘)' });
  });

  it('이모티콘만 있는 리뷰는 그림 조각으로 — 글이 없으니 그림을 봐야 한다', () => {
    const parts = prepareReviewParts([{ rating: 1, body: '[[emo:7]]' }], names);
    expect(parts).toEqual([
      { kind: 'text', text: '리뷰 1 · 별점 1/5 · 글 없이 이모티콘만 (바로 아래 그림 1장)' },
      { kind: 'emoticon-image', emoticonId: 7, label: '울음' },
    ]);
  });

  it('같은 이모티콘을 여러 번 붙여도 그림은 한 번, 종류가 많아도 상한까지만', () => {
    const body = '[[emo:1]][[emo:1]][[emo:2]][[emo:3]][[emo:4]][[emo:5]]';
    const parts = prepareReviewParts([{ rating: 5, body }], new Map());
    const images = parts.filter((p) => p.kind === 'emoticon-image');
    expect(images.map((p) => (p as { emoticonId: number }).emoticonId)).toEqual([1, 2, 3]);
    expect(images).toHaveLength(EMOTICON_IMAGES_PER_REVIEW);
    expect(parts[0]).toEqual({
      kind: 'text',
      text: `리뷰 1 · 별점 5/5 · 글 없이 이모티콘만 (바로 아래 그림 ${EMOTICON_IMAGES_PER_REVIEW}장)`,
    });
  });

  it('이모티콘 사이에 공백만 있어도 "이모티콘만" 으로 본다', () => {
    const parts = prepareReviewParts([{ rating: 4, body: ' [[emo:12]]  [[emo:7]] ' }], names);
    expect(parts.filter((p) => p.kind === 'emoticon-image')).toHaveLength(2);
  });

  it('리뷰 번호는 1부터, 순서는 입력 순서', () => {
    const parts = prepareReviewParts(
      [
        { rating: 5, body: 'a' },
        { rating: 1, body: 'b' },
      ],
      names,
    );
    expect(parts.map((p) => (p as { text: string }).text)).toEqual([
      '리뷰 1 · 별점 5/5 · a',
      '리뷰 2 · 별점 1/5 · b',
    ]);
  });

  it('g 플래그 정규식을 써도 두 번째 호출이 첫 호출과 같다 (lastIndex 함정)', () => {
    const one = prepareReviewParts([{ rating: 5, body: 'x [[emo:12]]' }], names);
    const two = prepareReviewParts([{ rating: 5, body: 'x [[emo:12]]' }], names);
    expect(two).toEqual(one);
  });

  it('요약 최소 리뷰 수는 5', () => {
    expect(REVIEW_SUMMARY_MIN).toBe(5);
  });

  it('대기·혼잡은 평가 칸이 아니다 — 지점이 관여할 수 없는 일 (2026-09-17 결정)', () => {
    expect(REVIEW_SUMMARY_KEYS.map((k) => k.key)).toEqual(['good', 'bad', 'condition']);
    expect(REVIEW_SUMMARY_KEYS.map((k) => k.label)).not.toContain('대기');
  });
});
