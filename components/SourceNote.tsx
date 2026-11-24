import { CC_BY_NC_SA_KR_URL, sourceDate } from '@/lib/attribution';
import type { ArcadeMachine, DataSource } from '@/lib/types';

/** 기종들의 출처를 문서(URL)별로 한 번씩만 — 확인일은 가장 늦은 날 */
export function machineSources(machines: ArcadeMachine[]): DataSource[] {
  const byUrl = new Map<string, DataSource>();
  for (const m of machines) {
    const s = m.source;
    if (!s) continue;
    const prev = byUrl.get(s.url);
    if (!prev || (s.checked ?? '') > (prev.checked ?? '')) byUrl.set(s.url, s);
  }
  return [...byUrl.values()];
}

/**
 * 바깥 자료에서 옮겨 온 보유 기종의 출처 한 줄 (migrate-085 · lib/attribution.ts).
 * 나무위키는 CC BY-NC-SA 라 문서 · 라이선스 · 고쳐 옮겼다는 사실을 자료가 보이는 자리에 밝힙니다.
 * 기종마다 붙이지 않고 게임 목록의 마지막 카드에 한 번만 보입니다(2026-11-24 사용자 결정).
 * 영업시간은 출처를 화면에 내지 않습니다(2026-11-24 결정) — hours_source_* 는 DB 에만 남깁니다.
 */
export default function SourceNote({ sources }: { sources: DataSource[] }) {
  if (sources.length === 0) return null;
  const latest = sources.reduce<string | null>(
    (a, s) => (s.checked && (!a || s.checked > a) ? s.checked : a),
    null,
  );
  const day = sourceDate(latest);
  return (
    <p className="muted small source-note">
      출처{' '}
      {sources.map((s, i) => (
        <span key={s.url}>
          {i > 0 && ', '}
          <a href={s.url} target="_blank" rel="noopener noreferrer">
            {s.title}
          </a>
        </span>
      ))}
      {day && <> · {day} 기준</>} ·{' '}
      <a href={CC_BY_NC_SA_KR_URL} target="_blank" rel="noopener noreferrer">
        CC BY-NC-SA 2.0 KR
      </a>{' '}
      · 줄여 옮김
    </p>
  );
}
