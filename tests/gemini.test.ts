import { ApiError } from '@google/genai';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyGeminiError,
  DEFAULT_GEMINI_MODEL,
  describeGeminiFailure,
  geminiClient,
  geminiModel,
  isTransportError,
} from '@/lib/gemini';

/**
 * Gemini 공통 계층 (2026-11-25). 네 기능이 같은 모델 이름과 같은 실패 판단을 쓰는지,
 * 그리고 크레딧 소진(402 · SSOT R32)과 시간 초과(R29)를 다른 실패와 갈라 내는지 봅니다.
 */
describe('geminiModel', () => {
  const saved = process.env.GEMINI_MODEL;
  afterEach(() => {
    if (saved === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = saved;
  });

  it('비어 있으면 기본값(3.5-flash-lite)', () => {
    delete process.env.GEMINI_MODEL;
    expect(geminiModel()).toBe(DEFAULT_GEMINI_MODEL);
    expect(DEFAULT_GEMINI_MODEL).toBe('gemini-3.5-flash-lite');
    process.env.GEMINI_MODEL = '   ';
    expect(geminiModel()).toBe(DEFAULT_GEMINI_MODEL);
  });

  it('환경변수로 바꿀 수 있다 (배포 없이 되돌리기)', () => {
    process.env.GEMINI_MODEL = ' gemini-3.8-flash ';
    expect(geminiModel()).toBe('gemini-3.8-flash');
  });
});

describe('geminiClient', () => {
  const saved = process.env.GEMINI_API_KEY;
  afterEach(() => {
    if (saved === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = saved;
  });

  it('키가 없거나 공백이면 null', () => {
    delete process.env.GEMINI_API_KEY;
    expect(geminiClient()).toBeNull();
    process.env.GEMINI_API_KEY = '  ';
    expect(geminiClient()).toBeNull();
  });

  it('키가 있으면 클라이언트', () => {
    process.env.GEMINI_API_KEY = 'test-key';
    expect(geminiClient()).not.toBeNull();
  });
});

describe('classifyGeminiError', () => {
  const api = (status: number, message = 'x') => new ApiError({ status, message });

  it('API 응답을 원인별로 가른다', () => {
    expect(classifyGeminiError(api(401))).toBe('key');
    expect(classifyGeminiError(api(403))).toBe('key');
    expect(classifyGeminiError(api(400, 'API key not valid. Please pass a valid API key.'))).toBe('key');
    expect(classifyGeminiError(api(402))).toBe('credit');
    expect(classifyGeminiError(api(404))).toBe('model');
    expect(classifyGeminiError(api(429))).toBe('rate');
    expect(classifyGeminiError(api(400, 'Invalid JSON payload'))).toBe('other');
    expect(classifyGeminiError(api(500))).toBe('other');
  });

  it('시간 제한에 걸린 것은 timeout — SDK 는 AbortError 를 그대로 던진다', () => {
    expect(classifyGeminiError(new DOMException('This operation was aborted', 'AbortError'))).toBe('timeout');
    expect(classifyGeminiError(new DOMException('signal timed out', 'TimeoutError'))).toBe('timeout');
    expect(classifyGeminiError(Object.assign(new Error('deadline'), { name: 'TimeoutError' }))).toBe('timeout');
  });

  it('연결 실패는 network, 나머지는 other', () => {
    expect(classifyGeminiError(new TypeError('fetch failed'))).toBe('network');
    expect(classifyGeminiError(new Error('boom'))).toBe('other');
    expect(classifyGeminiError('문자열')).toBe('other');
    expect(classifyGeminiError(null)).toBe('other');
  });
});

describe('isTransportError', () => {
  it('fetch failed 만 다시 보낼 만하다 — 시간 초과 · API 거절은 아니다', () => {
    expect(isTransportError(new TypeError('fetch failed'))).toBe(true);
    expect(isTransportError(new TypeError('x is not a function'))).toBe(false);
    expect(isTransportError(new DOMException('aborted', 'AbortError'))).toBe(false);
    expect(isTransportError(new ApiError({ status: 429, message: 'x' }))).toBe(false);
  });
});

describe('describeGeminiFailure', () => {
  it('크레딧 소진은 키 문제와 다른 말로 남긴다 (R32)', () => {
    expect(describeGeminiFailure('credit')).toMatch(/크레딧/);
    expect(describeGeminiFailure('key')).toMatch(/GEMINI_API_KEY/);
    expect(describeGeminiFailure('model', 'm-1')).toMatch(/m-1/);
  });
});
