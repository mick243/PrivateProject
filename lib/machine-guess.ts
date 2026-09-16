import { GoogleGenAI, Type } from '@google/genai';
import { listMachineGuesses, listMachines } from './arcades';
import { getDb } from './db';
import type { MachineGuess } from './types';

/**
 * 오락실 **한 곳**의 보유 기종을 검색으로 추정해 arcade_machine_guesses 에 쌓습니다.
 *
 * 상세 화면의 "AI 로 기종 찾기" 단추가 부릅니다 (app/api/arcades/[id]/guesses POST).
 * 배치로 여러 곳을 훑는 것은 scripts/guess-arcade-machines.mjs 입니다.
 *
 * ⚠ 두 곳의 **프롬프트·매칭 규칙은 같아야 합니다.** 스크립트는 .ts 를 import 할 수
 *   없어서(Node 가 `@/` 별칭과 확장자 없는 import 를 풀지 못합니다) 옮겨 적은 것입니다
 *   (scripts/db-files.mjs 가 lib/db.ts 목록을 옮겨 적는 것과 같은 사정). 한쪽을 고치면
 *   다른 쪽도 고치세요 — 어긋나면 단추로 찾은 것과 배치로 찾은 것이 다른 답을 냅니다.
 *
 * ─── ⚠ 호출이 두 번인 이유 ────────────────────────────────
 * `responseSchema` 와 `googleSearch` 를 같이 주면 **검색이 돌지 않습니다.** 오류도
 * 없이 모델이 기억으로 답하고 스키마에 맞는 JSON 을 돌려줍니다(검색 질의 0건인데
 * 답에는 '나무위키' 를 출처로 적어 두었습니다). 그래서 검색은 자유 문장으로 받고,
 * 그 문장을 도구 없이 스키마로 다시 훑습니다.
 *
 * ─── 확정과 섞지 않습니다 ─────────────────────────────────
 * arcade_machines 에 쓰지 않고 임계값에도 세지 않습니다 (migrate-061 머리말).
 */

/** 챗봇(app/api/chat)과 같은 모델 — 두 곳이 다른 답을 내면 사용자가 먼저 알아챕니다. */
const MODEL = 'gemini-3.7-flash';

export class MachineGuessUnavailable extends Error {}

export interface GuessOutcome {
  /** 검색이 실제로 돌았는지. false 면 모델이 기억으로 답한 것이라 결과를 버렸습니다. */
  searched: boolean;
  /** 이번에 저장(갱신)한 추정 수. **확정 기종과 겹치는 것도 셉니다.** */
  found: number;
  /**
   * 그중 화면에 실제로 뜨는 수.
   *
   * 확정된 기종은 추정 목록에서 빠지므로(listMachineGuesses) found 보다 작을 수
   * 있고, 전부 겹치면 0 입니다. 두 수를 나눠 두지 않으면 "3개 찾았습니다" 라고
   * 말해 놓고 상자가 비어 있는 화면이 나옵니다 — 누른 사람은 검색이 헛돈 줄 압니다.
   */
  fresh: number;
  /** 저장 뒤의 추정 목록 — 확정된 기종은 빠져 있습니다 (listMachineGuesses) */
  guesses: MachineGuess[];
}

const schema = {
  type: Type.OBJECT,
  properties: {
    machines: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING, description: '기종 이름 (주어진 목록의 표기 그대로)' },
          evidence: { type: Type.STRING, description: '그렇게 본 근거 — 출처 주소나 인용' },
        },
        required: ['name', 'evidence'],
      },
    },
  },
  required: ['machines'],
};

export async function guessMachines(arcadeId: number): Promise<GuessOutcome> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new MachineGuessUnavailable('GEMINI_API_KEY 가 없어 검색할 수 없습니다');
  }

  const db = await getDb();
  const { rows } = await db.query<{ name: string; address: string | null }>(
    `SELECT name, address FROM arcades WHERE id = $1::int`,
    [arcadeId],
  );
  const arcade = rows[0];
  if (!arcade) throw new MachineGuessUnavailable('그런 오락실이 없습니다');

  // 리듬게임 기종만. 목록을 코드에 적지 않고 DB 에서 읽는 이유는 관리자가 기종을
  // 더하거나 뺄 때 여기가 따라 움직여야 하기 때문입니다 (챗봇 시스템 프롬프트와 같은 규칙).
  const machines = (await listMachines()).filter((m) => m.category === 'rhythm');

  /*
    모델이 준 이름을 우리 기종 id 로 바꿉니다. 정확 일치로는 거의 다 놓칩니다 —
    모델은 "펌프 잇 업 (Pump It Up PHOENIX)" 처럼 버전과 원어를 함께 적습니다.
    그래서 우리 이름이 그 안에 **들어 있는지**를 보고, 짧은 이름이 긴 이름의 일부인
    경우('EZ2AC' 안의 'EZ2')가 있어 긴 이름부터 봅니다.
  */
  const needles = machines
    .flatMap((m) => [m.name, m.shortName].filter(Boolean).map((n) => ({ n: n.toLowerCase(), id: m.id })))
    .sort((a, b) => b.n.length - a.n.length);
  const machineIdOf = (raw: unknown): number | undefined => {
    const t = String(raw ?? '').toLowerCase();
    return t.trim() === '' ? undefined : needles.find((x) => t.includes(x.n))?.id;
  };

  const where = [arcade.name, arcade.address].filter(Boolean).join(' · ');
  const system = `당신은 한국 오락실의 보유 리듬게임 기종을 찾는 조사원입니다.

규칙:
- 아래 목록에 있는 기종만 답하세요. 목록에 없는 게임은 버리세요.
- **검색으로 확인한 것만** 답하세요. 기억이나 추측으로 채우지 마세요.
- 근거(evidence)에는 실제로 본 출처의 주소나 문장을 적으세요. 근거를 댈 수 없으면
  그 기종을 빼세요. 빈 배열이 틀린 답보다 낫습니다.
- 오락실 이름이 비슷한 다른 지점과 헷갈리지 마세요. 주소가 일치하는지 보세요.

기종 목록: ${machines.map((m) => m.name + (m.shortName ? `(${m.shortName})` : '')).join(', ')}`;

  const ai = new GoogleGenAI({ apiKey });

  // 1차 — 검색. 스키마를 주면 검색이 돌지 않으므로 자유 문장으로 받습니다.
  const searched = await ai.models.generateContent({
    model: MODEL,
    contents: `오락실: ${where}\n\n이 오락실에 있는 리듬게임 기종을 찾아 주세요. 각 기종마다 출처(주소나 인용)를 함께 적어 주세요.`,
    config: { systemInstruction: system, tools: [{ googleSearch: {} }], maxOutputTokens: 2000 },
  });
  const queries = searched.candidates?.[0]?.groundingMetadata?.webSearchQueries ?? [];
  const prose = searched.text ?? '';
  // 질의가 0건이면 기억으로 답한 것 — 이 기능이 존재하는 이유가 '검색으로 확인한 것' 입니다.
  if (queries.length === 0 || prose.trim() === '') {
    return { searched: false, found: 0, fresh: 0, guesses: await listMachineGuesses(arcadeId) };
  }

  // 2차 — 그 문장에서 구조를 뽑습니다. 여기서는 도구를 주지 않습니다.
  const shaped = await ai.models.generateContent({
    model: MODEL,
    contents: `아래 글에서 기종과 근거만 뽑으세요. 글에 없는 것을 지어내지 마세요.\n\n${prose}`,
    config: {
      systemInstruction: `주어진 글에서만 뽑습니다. 기종 이름은 이 목록의 표기로 적으세요: ${machines.map((m) => m.name).join(', ')}`,
      responseMimeType: 'application/json',
      responseSchema: schema,
      maxOutputTokens: 1500,
    },
  });
  const parsed = JSON.parse(shaped.text ?? '{}') as { machines?: { name?: unknown; evidence?: unknown }[] };

  const found = new Map<number, string>();
  for (const g of parsed.machines ?? []) {
    const id = machineIdOf(g.name);
    const evidence = String(g.evidence ?? '').trim();
    // 목록에 없는 이름·근거 없는 줄은 버립니다 — 조용히 넘어가면 화면에 없는 기종이 뜹니다.
    if (id === undefined || evidence === '' || found.has(id)) continue;
    found.set(id, evidence.slice(0, 500));
  }

  for (const [machineId, evidence] of found) {
    await db.query(
      `INSERT INTO arcade_machine_guesses (arcade_id, machine_id, evidence, model)
            VALUES ($1, $2, $3, $4)
       ON CONFLICT (arcade_id, machine_id)
       DO UPDATE SET evidence = EXCLUDED.evidence, model = EXCLUDED.model, created_at = now()`,
      [arcadeId, machineId, evidence, MODEL],
    );
  }

  // 이번에 찾은 것 중 몇 개가 실제로 화면에 뜨는지 셉니다. 목록은 이미 확정된
  // 기종을 걸러 내므로, 여기 남은 것만이 사람이 보게 될 줄입니다.
  const guesses = await listMachineGuesses(arcadeId);
  const visible = new Set(guesses.map((g) => g.machineId));
  const fresh = [...found.keys()].filter((id) => visible.has(id)).length;

  return { searched: true, found: found.size, fresh, guesses };
}
