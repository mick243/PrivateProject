import { EMOTICON_TOKEN_RE } from './community-types';

/**
 * 리뷰 AI 요약 — **클라이언트에서도 import 합니다** (*-types.ts 규칙).
 *
 * lib/review-summary.ts 는 getDb 와 @google/genai 를 끌고 오므로 컴포넌트에서
 * 못 씁니다. 화면과 서버가 함께 봐야 하는 모양, 그리고 **입출력이 없는 순수
 * 함수**(prepareReviewParts)만 여기 둡니다 — 순수라야 테스트가 모델 없이 돕니다.
 */

/** 이 수 이상이어야 요약을 만듭니다. 셋으로 요약하면 요약이 아니라 옮겨 적기입니다 */
export const REVIEW_SUMMARY_MIN = 5;

/**
 * 세 칸. 각각 한 줄이고, 리뷰에 그 얘기가 없으면 null.
 *
 * **대기·혼잡은 칸이 아닙니다.** 손님이 몇 명 오느냐는 지점이 어떻게 할 수 있는 일이
 * 아니라서, 평가 항목에 넣으면 지점이 잘못한 것처럼 읽힙니다. 다른 칸에도 대기 얘기를
 * 적지 않게 프롬프트가 막습니다(lib/review-summary.ts SYSTEM). 실시간 대기는 제보
 * 화면(/live)이 따로 다룹니다 — 그쪽이 맞는 자리입니다.
 */
export interface ReviewSummary {
  /** 좋은 점 */
  good: string | null;
  /** 아쉬운 점 */
  bad: string | null;
  /** 기체 상태 (센서·발판·모니터 등) */
  condition: string | null;
}

export const REVIEW_SUMMARY_KEYS: { key: keyof ReviewSummary; label: string }[] = [
  { key: 'good', label: '좋은 점' },
  { key: 'bad', label: '아쉬운 점' },
  { key: 'condition', label: '기체 상태' },
];

/** GET /api/arcades/:id/reviews/summary 가 돌려주는 모양 */
export interface ReviewSummaryView {
  summary: ReviewSummary;
  /** 이 요약이 근거로 삼은 리뷰 수 — 화면에 "후기 N개 기준" 으로 찍힙니다 */
  reviewCount: number;
  /** 별점 평균은 모델이 아니라 SQL 이 냅니다 (arcades.rating_avg) */
  ratingAvg: number | null;
  createdAt: string;
}

// ─── 모델에 넣을 재료 만들기 (순수) ────────────────────────

export interface SummaryReviewInput {
  rating: number;
  body: string | null;
}

/**
 * 모델에 보낼 조각. 글은 text, **이모티콘만 있는 리뷰**는 그림 조각으로 갑니다 —
 * 글이 없으니 그림을 봐야 무슨 뜻인지 알 수 있습니다. 글과 이모티콘이 섞인 리뷰는
 * 이모티콘을 이름으로 바꿔 글에 끼웁니다. 이미 글이 있으면 그림까지 볼 값어치가
 * 없고(호출당 크기가 커집니다), 이름이 "박수" "울음" 이면 뜻은 충분히 전해집니다.
 */
export type PreparedPart =
  | { kind: 'text'; text: string }
  | { kind: 'emoticon-image'; emoticonId: number; label: string };

/** 한 리뷰에서 그림으로 보낼 이모티콘 상한. 같은 그림을 열 번 붙인 리뷰가 있습니다 */
export const EMOTICON_IMAGES_PER_REVIEW = 3;

/**
 * 리뷰 목록을 모델에 넣을 조각으로 바꿉니다.
 *
 * - `[[emo:N]]` 마커는 **그대로 보내지 않습니다.** 보내면 요약에 "emo 12" 같은 말이
 *   튀어나옵니다.
 * - 이름을 모르는 이모티콘(지워진 것)은 `(이모티콘)` 으로만 적습니다.
 * - 리뷰마다 별점을 함께 적습니다. 별점 1점의 "괜찬네요" 와 5점의 "괜찬네요" 는
 *   뜻이 다릅니다.
 */
export function prepareReviewParts(
  reviews: SummaryReviewInput[],
  emoticonNames: Map<number, string>,
): PreparedPart[] {
  const parts: PreparedPart[] = [];

  reviews.forEach((r, i) => {
    const head = `리뷰 ${i + 1} · 별점 ${r.rating}/5`;
    const body = (r.body ?? '').trim();
    if (body === '') {
      parts.push({ kind: 'text', text: `${head} · 본문 없음` });
      return;
    }

    // split 은 [글, id, 글, id, …] 로 갈라 줍니다 (components/EmoticonText.tsx 와 같은 계약)
    EMOTICON_TOKEN_RE.lastIndex = 0;
    const pieces = body.split(EMOTICON_TOKEN_RE);
    const ids: number[] = [];
    let text = '';
    pieces.forEach((piece, k) => {
      if (k % 2 === 0) {
        text += piece;
        return;
      }
      const id = Number(piece);
      ids.push(id);
      const name = emoticonNames.get(id);
      text += name ? `(이모티콘: ${name})` : '(이모티콘)';
    });

    const wordsOnly = pieces.filter((_, k) => k % 2 === 0).join('').trim();
    if (wordsOnly === '' && ids.length > 0) {
      // 글 없이 이모티콘만 — 그림을 봐야 합니다. 같은 그림은 한 번만.
      const unique = [...new Set(ids)].slice(0, EMOTICON_IMAGES_PER_REVIEW);
      parts.push({ kind: 'text', text: `${head} · 글 없이 이모티콘만 (바로 아래 그림 ${unique.length}장)` });
      for (const id of unique) {
        parts.push({ kind: 'emoticon-image', emoticonId: id, label: emoticonNames.get(id) ?? '이름 없음' });
      }
      return;
    }

    parts.push({ kind: 'text', text: `${head} · ${text.replace(/\s+/g, ' ').trim()}` });
  });

  return parts;
}
