import { GoogleGenAI, Type } from '@google/genai';
import { EMOTICON_TOKEN_RE } from './community-types';
import { getDb } from './db';
import { getEmoticonsByIds } from './emoticons';
import { listReviews } from './reviews';
import {
  prepareReviewParts,
  REVIEW_SUMMARY_KEYS,
  REVIEW_SUMMARY_MIN,
  type ReviewSummary,
  type ReviewSummaryView,
} from './review-summary-types';
import { read } from './uploads';

/**
 * 오락실 **한 곳**의 리뷰를 세 줄로 요약해 arcade_review_summaries 에 저장합니다
 * (db/migrate-073-review-summaries.sql).
 *
 * 부르는 곳은 GET /api/arcades/:id/reviews/summary 하나입니다 — 상세를 여는 사람이
 * 저장된 요약이 없거나 낡았을 때 한 번 만듭니다. 리뷰를 쓰거나 지우면 lib/reviews.ts
 * 가 저장된 줄을 지우므로, 다음 사람이 새로 만듭니다.
 *
 * ─── 이모티콘만 있는 리뷰는 그림으로 보냅니다 ──────────────
 * 글이 없으면 이름만으로는 부족합니다("Hmm" 이라는 이름은 감정을 말해 주지 않습니다).
 * 그 리뷰의 이모티콘 파일을 inlineData 로 붙여 모델이 그림을 보게 합니다. 글이 있는
 * 리뷰는 이모티콘을 이름으로 바꿔 글에 끼웁니다 — 판단은 lib/review-summary-types.ts
 * prepareReviewParts 가 하고(순수 함수, 테스트 있음), 여기는 파일만 읽어 붙입니다.
 *
 * ─── 숫자는 모델에 맡기지 않습니다 ────────────────────────
 * 별점 평균은 arcades.rating_avg(SQL)에서 읽습니다. 모델이 "평균 4.2" 라고 적으면
 * 그 값이 맞는지 아무도 모릅니다. 프롬프트에서도 숫자를 적지 말라고 합니다.
 */

/**
 * 기종 추정(lib/machine-guess.ts)과 같은 모델입니다. 그쪽 상수를 가져오지 않는 이유는
 * 그 모듈이 검색 도구까지 끌고 오기 때문입니다 — 요약은 검색이 필요 없습니다.
 */
const MODEL = 'gemini-3.7-flash';

/**
 * inlineData 로 보낼 수 있는 그림 형식.
 *
 * 공식 문서 목록에는 png·jpeg·webp·heic·heif 만 있지만, **gif 도 실제로 받습니다**
 * (2026-09-17 에 이 저장소의 이모티콘 파일로 확인). 이 프로젝트의 이모티콘은 대부분
 * gif 라 이걸 빼면 기능이 거의 비어 버립니다. 언젠가 거절하기 시작하면 아래 fallback
 * (이름만 보냄)으로 조용히 내려갑니다 — 요약 자체는 계속 됩니다.
 */
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
/** 이모티콘 등록 상한(EMOTICON_MAX_BYTES)과 같습니다. 그보다 큰 파일은 있을 수 없지만, 있다면 보내지 않습니다 */
const IMAGE_MAX_BYTES = 2 * 1024 * 1024;

export class ReviewSummaryUnavailable extends Error {}
export class NotEnoughReviews extends Error {}

const schema = {
  type: Type.OBJECT,
  properties: {
    good: { type: Type.STRING, nullable: true, description: '좋은 점 — 한 문장. 리뷰에 없으면 null' },
    bad: { type: Type.STRING, nullable: true, description: '아쉬운 점 — 한 문장. 없으면 null' },
    condition: {
      type: Type.STRING,
      nullable: true,
      description: '기체 상태(센서·발판·모니터·음향) — 한 문장. 없으면 null',
    },
  },
  required: ['good', 'bad', 'condition'],
};

const SYSTEM = `당신은 오락실 리뷰를 요약하는 편집자입니다. 아래 리뷰들만 근거로 세 칸을 채우세요.

- good: 좋은 점 / bad: 아쉬운 점 / condition: 기체 상태(센서·발판·모니터·음향)
- 각 칸은 한국어 평서문 한 문장, 60자 이내.
- 대기 시간·혼잡도·사람이 많다/적다는 **어느 칸에도 적지 마세요.** 손님이 몇 명 오느냐는 지점이 어떻게 할 수 있는 일이 아니라 지점 평가가 아닙니다. 리뷰가 대기 얘기만 하면 그 리뷰는 요약에서 빼세요.
- 리뷰에 없는 내용은 지어내지 말고 그 칸을 null 로 두세요. 빈 칸이 틀린 문장보다 낫습니다.
- 그림(이모티콘)만 있는 리뷰는 그림이 나타내는 감정·태도를 그 리뷰의 뜻으로 삼되, 함께 적힌 별점과 같이 보세요.
- 별점 평균·리뷰 수 같은 숫자는 적지 마세요. 따로 계산됩니다.
- 특정 작성자를 가리키지 마세요. "한 리뷰는", "여러 리뷰가" 처럼 적으세요.`;

type Part =
  | { text: string }
  /** 그림 조각. `fallback` 은 그림을 보낼 수 없을 때 대신 넣을 한 줄(이름만) */
  | { inlineData: { mimeType: string; data: string }; fallback: string };

/** 그림 조각을 전부 이름 한 줄로 바꾼 사본 — 본문이 수 KB 로 줄어듭니다 */
function withoutImages(parts: Part[]): { text: string }[] {
  return parts.map((p) => ('inlineData' in p ? { text: p.fallback } : p));
}

/**
 * 전송 단계 실패인가 — 모델이 거절한 것이 아니라 연결이 안 된 것.
 *
 * undici 는 TLS·DNS·연결 끊김을 전부 `TypeError: fetch failed` 로 던집니다. 재시작
 * 직후 첫 호출이 이걸로 한 번 떨어지고 바로 다음 호출은 되는 것을 봤습니다
 * (2026-09-17). 이런 것만 한 번 더 시도합니다 — 400·429 같은 API 응답은 다시 보내도
 * 같은 답이 오므로 재시도하지 않습니다.
 */
function isTransportError(err: unknown): boolean {
  return err instanceof TypeError && /fetch failed/i.test(err.message);
}

/** 모델이 준 값을 화면에 그대로 내보낼 수 있게 다듬습니다 — 빈 문자열은 null, 길면 자름 */
function tidy(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/\s+/g, ' ').trim();
  return s === '' ? null : s.slice(0, 200);
}

export type SummaryLookup =
  | { kind: 'ready'; view: ReviewSummaryView }
  /** 저장된 것이 없거나(missing) 리뷰 수가 달라 낡았음(stale) */
  | { kind: 'missing' | 'stale'; reviewCount: number; ratingAvg: number | null }
  | { kind: 'no-arcade' };

/**
 * 저장된 요약을 봅니다. 모델을 부르지 않습니다.
 *
 * 낡았는지는 `review_count` 비교로 봅니다. 같은 사람이 리뷰를 **고친** 경우는 수가
 * 같아 여기서 못 잡지만, 그때는 lib/reviews.ts 가 줄을 지워 두므로 missing 이 됩니다.
 */
export async function lookupReviewSummary(arcadeId: number): Promise<SummaryLookup> {
  const db = await getDb();
  const { rows } = await db.query<{
    review_count: number | string;
    rating_avg: number | string | null;
    cached_count: number | string | null;
    summary: ReviewSummary | null;
    created_at: Date | string | null;
  }>(
    `SELECT a.review_count, a.rating_avg,
            s.review_count AS cached_count, s.summary, s.created_at
       FROM arcades a
       LEFT JOIN arcade_review_summaries s ON s.arcade_id = a.id
      WHERE a.id = $1::int`,
    [arcadeId],
  );
  const r = rows[0];
  if (!r) return { kind: 'no-arcade' };

  const reviewCount = Number(r.review_count);
  const ratingAvg = r.rating_avg === null ? null : Number(r.rating_avg);
  if (r.cached_count === null || !r.summary) return { kind: 'missing', reviewCount, ratingAvg };
  if (Number(r.cached_count) !== reviewCount) return { kind: 'stale', reviewCount, ratingAvg };

  const createdAt = r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at);
  return {
    kind: 'ready',
    view: { summary: r.summary, reviewCount: Number(r.cached_count), ratingAvg, createdAt },
  };
}

/**
 * 리뷰를 읽어 모델에 보내고, 받은 세 칸을 저장한 뒤 돌려줍니다.
 *
 * 동시에 두 사람이 열어 두 번 만들어질 수 있습니다. 막지 않습니다 — UPSERT 라 결과는
 * 같고, 그 비용은 모델 호출 한 번입니다. 잠금을 두면 첫 사람이 느릴 때 두 번째
 * 사람이 기다려야 하는데, 그쪽이 더 나쁜 경험입니다.
 */
export async function buildReviewSummary(arcadeId: number): Promise<ReviewSummaryView> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new ReviewSummaryUnavailable('GEMINI_API_KEY 가 없어 요약할 수 없습니다');

  const reviews = await listReviews(arcadeId);
  if (reviews.length < REVIEW_SUMMARY_MIN) {
    throw new NotEnoughReviews(`리뷰가 ${REVIEW_SUMMARY_MIN}개 이상이어야 요약합니다`);
  }

  // 본문에 박힌 이모티콘 id 를 모아 이름·파일을 한 번에 읽습니다 (지운 것도 — 옛 리뷰).
  const ids: number[] = [];
  for (const r of reviews) {
    for (const m of (r.body ?? '').matchAll(EMOTICON_TOKEN_RE)) ids.push(Number(m[1]));
  }
  const emoticons = await getEmoticonsByIds(ids);
  const names = new Map([...emoticons].map(([id, e]) => [id, e.name]));

  const prepared = prepareReviewParts(
    reviews.map((r) => ({ rating: r.rating, body: r.body })),
    names,
  );

  const parts: Part[] = [{ text: `오락실 리뷰 ${reviews.length}개입니다. 최근 것부터입니다.` }];
  for (const p of prepared) {
    if (p.kind === 'text') {
      parts.push({ text: p.text });
      continue;
    }
    // 이모티콘만 있는 리뷰의 그림. 파일이 없거나 형식이 안 맞으면 이름만 — 요약은 계속됩니다.
    const e = emoticons.get(p.emoticonId);
    const buf = e && IMAGE_MIMES.has(e.mime) ? await read(e.storageKey) : null;
    if (!e || !buf || buf.byteLength > IMAGE_MAX_BYTES) {
      parts.push({ text: `(이모티콘 "${p.label}" — 그림을 보낼 수 없어 이름만 적습니다)` });
      continue;
    }
    parts.push({
      inlineData: { mimeType: e.mime, data: buf.toString('base64') },
      fallback: `(이모티콘 "${p.label}" — 그림을 보낼 수 없어 이름만 적습니다)`,
    });
  }

  const images = parts.filter((p) => 'inlineData' in p).length;
  // 본문은 남기지 않습니다 — 얼마나 큰 요청이었는지만 (운영에서 비용·실패를 볼 때 씁니다).
  console.info(`[review-summary] arcade ${arcadeId}: 리뷰 ${reviews.length}개 · 그림 ${images}장 → ${MODEL}`);

  const ai = new GoogleGenAI({ apiKey });
  const call = (body: Part[]) =>
    ai.models.generateContent({
      model: MODEL,
      // SDK 에는 우리 fallback 필드를 넘기지 않습니다 — 모르는 키를 거절할 수 있습니다.
      contents: [{ role: 'user', parts: body.map((p) => ('inlineData' in p ? { inlineData: p.inlineData } : p)) }],
      config: {
        systemInstruction: SYSTEM,
        responseMimeType: 'application/json',
        responseSchema: schema,
        maxOutputTokens: 1500,
      },
    });

  /*
    시도 순서 — 그림 포함 → 그림 포함(재시도) → 그림 없이.

    이 PC 에서 1.4MB 짜리 요청이 간헐적으로 `fetch failed` 로 끊기는 것을 봤습니다
    (2026-09-17 · 같은 본문이 바로 다음엔 통과). 두 번 연속 끊기면 그림을 빼고 이름만으로
    한 번 더 보냅니다 — 본문이 수 KB 라 거의 확실히 통과하고, 요약의 뼈대(글이 있는
    리뷰)는 그대로입니다. 이모티콘만 있는 리뷰는 이때 이름으로만 반영됩니다. 그림을
    못 본 요약을 저장하는 것과 502 를 돌려주는 것 중, 사용자에게는 앞이 낫습니다.
    API 가 거절한 오류(400·429 등)는 재시도하지 않습니다 — 다시 보내도 같은 답입니다.
  */
  const attempts: { label: string; body: Part[] }[] = [
    { label: '그림 포함', body: parts },
    { label: '그림 포함 · 재시도', body: parts },
    { label: '그림 없이', body: images > 0 ? withoutImages(parts) : parts },
  ];
  let res: Awaited<ReturnType<typeof call>> | undefined;
  for (let i = 0; i < attempts.length; i++) {
    try {
      res = await call(attempts[i].body);
      if (i > 0) console.warn(`[review-summary] arcade ${arcadeId}: ${attempts[i].label} 로 성공`);
      break;
    } catch (err) {
      const last = i === attempts.length - 1;
      if (!isTransportError(err) || last) throw err;
      console.warn(`[review-summary] arcade ${arcadeId}: ${attempts[i].label} 연결 실패 — ${attempts[i + 1].label} 로 다시`);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  if (!res) throw new Error('요약 호출이 끝나지 않았습니다');

  const parsed = JSON.parse(res.text ?? '{}') as Record<string, unknown>;
  const summary = Object.fromEntries(
    REVIEW_SUMMARY_KEYS.map(({ key }) => [key, tidy(parsed[key])]),
  ) as unknown as ReviewSummary;

  const db = await getDb();
  const { rows } = await db.query<{ created_at: Date | string; rating_avg: number | string | null }>(
    `INSERT INTO arcade_review_summaries (arcade_id, review_count, summary, model)
     VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT (arcade_id)
       DO UPDATE SET review_count = EXCLUDED.review_count, summary = EXCLUDED.summary,
                     model = EXCLUDED.model, created_at = now()
     RETURNING created_at, (SELECT rating_avg FROM arcades WHERE id = $1) AS rating_avg`,
    [arcadeId, reviews.length, JSON.stringify(summary), MODEL],
  );
  const row = rows[0];
  return {
    summary,
    reviewCount: reviews.length,
    ratingAvg: row.rating_avg === null ? null : Number(row.rating_avg),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}
