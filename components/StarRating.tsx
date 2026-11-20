'use client';

interface Props {
  /** null 이면 아직 평가 없음 */
  value: number | null;
  /** 넘기면 입력용, 없으면 표시용 */
  onChange?: (value: number) => void;
  disabled?: boolean;
}

const STARS = [1, 2, 3, 4, 5];

/** 표시할 때는 반올림해 채우고, 입력할 때는 정수 1~5 만 받는다. */
export default function StarRating({ value, onChange, disabled }: Props) {
  const filled = value === null ? 0 : Math.round(value);

  if (!onChange) {
    return (
      // 평균(4.3333…)이 그대로 읽히지 않게 소수 한 자리로 줄여 읽는다
      <span
        className="stars"
        role="img"
        aria-label={
          value === null ? '아직 평점이 없어요' : `5점 만점에 ${Math.round(value * 10) / 10}점`
        }
      >
        {STARS.map((s) => (
          <i key={s} className={s <= filled ? 'star is-on' : 'star'}>
            ★
          </i>
        ))}
      </span>
    );
  }

  return (
    <span className="stars is-input">
      {STARS.map((s) => (
        <button
          key={s}
          type="button"
          className={s <= filled ? 'star is-on' : 'star'}
          disabled={disabled}
          onClick={() => onChange(s)}
          aria-label={`${s}점 주기`}
        >
          ★
        </button>
      ))}
    </span>
  );
}
