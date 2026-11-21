import { z } from 'zod';
import { MIN_PASSWORD_LENGTH } from '@/lib/auth-types';

/**
 * 비밀번호 찾기 라우트의 입력 (app/api/auth/password-reset/**). 화면(클라이언트)도 같은 문구를 쓰므로 서버 전용 모듈을 끌어오지 않습니다.
 * 문구는 가입(lib/validation.ts signupInputSchema)과 같은 말을 씁니다.
 */

export const resetRequestSchema = z.object({
  identifier: z
    .string({ error: '아이디나 이메일을 입력해 주세요' })
    .trim()
    .min(1, '아이디나 이메일을 입력해 주세요')
    .max(254, '아이디나 이메일을 다시 확인해 주세요'),
});

/** 토큰은 32바이트 base64url(43자). 넉넉히 받되 터무니없이 긴 값은 해시하지 않습니다 */
const tokenField = z
  .string({ error: '링크를 다시 열어 주세요' })
  .min(1, '링크를 다시 열어 주세요')
  .max(200, '링크를 다시 열어 주세요');

export const resetCheckSchema = z.object({ token: tokenField });

export const resetConfirmSchema = z
  .object({
    token: tokenField,
    password: z
      .string()
      .min(MIN_PASSWORD_LENGTH, `비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상으로 정해 주세요`)
      .max(200, '비밀번호는 200자까지 쓸 수 있어요'),
    passwordConfirm: z.string(),
  })
  .refine((v) => v.password === v.passwordConfirm, {
    message: '두 비밀번호가 달라요. 다시 확인해 주세요',
    path: ['passwordConfirm'],
  });
