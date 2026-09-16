'use client';

import { memo, type ReactNode } from 'react';
import type { ScoredArcade } from '@/lib/recommend';
import { formatDistance } from '@/lib/geo';
import type { Arcade, ArcadeCabinet } from '@/lib/types';
import { WaitBadge } from './LiveBadge';
import StarRating from './StarRating';

interface Props {
  /** 거리까지 계산해 둔 목록 (lib/recommend.ts rankArcades) */
  items: ScoredArcade[];
  loading: boolean;
  selectedId: number | null;
  /** 관리자일 때만 행에 수정·삭제가 붙는다 (판정은 서버가 한 번 더 한다) */
  canEdit: boolean;
  /**
   * 로그인했을 때만 별이 붙는다. 비로그인에 회색 별을 띄우면 눌러도 아무 일이
   * 없는 버튼이 되고, 왜 안 되는지는 그 자리에 적을 곳이 없다 —
   * 대신 목록 머리글이 "로그인하면 즐겨찾기" 를 말한다 (ArcadeFinder).
   */
  canFavorite: boolean;
  isFavorite: (id: number) => boolean;
  onToggleFavorite: (id: number) => void;
  onSelect: (id: number) => void;
  /** 선택 해제 — 지도 강조(확대 핀)를 끄고 평범한 좌표 마커로 되돌린다 */
  onClearSelect: () => void;
  onEdit: (arcade: Arcade) => void;
  onDelete: (arcade: Arcade) => void;
  /**
   * 비어 있을 때 할 말. 부모(ArcadeFinder listEmptyState)가 **왜 비었는지에 따라**
   * 다른 것을 넘긴다 — 기종 필터가 0곳이면 그 이유와 '필터 끄기' 버튼까지 온다.
   *
   * 2026-09-13 까지는 여기가 `null`(= 아무것도 안 그림)이었다. "없는 것을 설명하는
   * 한 줄이 그 자리를 채우면 그게 화면의 내용이 된다" 는 이유였는데, 실제로 써 보니
   * **기종 필터 14개 중 12개가 0곳**이라 사용자가 보는 것은 여백이 아니라 고장이었다.
   * 크라우드소싱 서비스에서 빈 화면은 "아직 아무도 안 알려 줬다" 는 뜻이므로,
   * 그 자리가 제보를 부탁할 자리다.
   *
   * `null` 은 여전히 "아무것도 그리지 않음" 이다 (조회 중 등).
   */
  emptyMessage?: ReactNode;
}

/**
 * 목록에 찍을 기체 1대의 컨디션 — 등록값과 제보를 종합해 반올림한 값.
 * 종합·반올림은 db/views.sql 의 cabinet_condition 이 하므로 그대로 쓴다.
 */
function cabinetCondition(c: ArcadeCabinet): number | null {
  return c.conditionSummary?.value ?? null;
}

/**
 * 영업시간 한 줄. **모르면 null** 이고, 그때는 줄 자체를 그리지 않는다.
 *
 * 예전에는 '영업시간 미등록' 을 돌려줬다. 그런데 939곳 중 영업시간이 있는 곳이
 * 1곳이라(네이버 지역 검색이 그 필드를 주지 않는다) 목록 열 줄이 모두 같은 말을
 * 반복했고, 화면에서 가장 눈에 띄는 것이 '없음' 이었다 (2026-09-13 UX 점검).
 * 없는 정보를 열 번 말하는 것보다 말하지 않는 쪽이 낫다 — 상세에서는 여전히
 * 알려 준다(ArcadeDetailPanel).
 */
function hours(a: Arcade): string | null {
  if (a.is24h) return '24시간';
  if (a.openTime && a.closeTime) return `${a.openTime} ~ ${a.closeTime}`;
  return null;
}

/** 수집한 주소를 링크로 쓸 수 있는지 — 데이터에서 온 값이라 스킴을 확인한다 */
export function isHttpUrl(raw: string | null): boolean {
  return raw !== null && /^https?:\/\//i.test(raw);
}

/**
 * memo 인 이유: 부모(ArcadeFinder)는 검색어 타이핑·상세 패널 조작 등 목록과
 * 무관한 이유로도 다시 렌더된다. 줄마다 뱃지·별점·대기 표시가 달려 있어
 * 공짜가 아니다. items 는 부모가 useMemo 로, 콜백들은 useCallback 으로
 * 참조를 지켜 준다 — 여기만 memo 를 씌워서는 아무것도 아끼지 못한다.
 */
export default memo(ArcadeList);

function ArcadeList({
  items,
  loading,
  selectedId,
  canEdit,
  canFavorite,
  isFavorite,
  onToggleFavorite,
  onSelect,
  onClearSelect,
  onEdit,
  onDelete,
  emptyMessage = '조건에 맞는 오락실이 없습니다.',
}: Props) {
  if (loading) return <p className="muted pad">불러오는 중…</p>;
  if (items.length === 0) {
    if (emptyMessage === null || emptyMessage === undefined) return null;
    return (
      <div className="list-empty pad" role="status">
        {typeof emptyMessage === 'string' ? <p className="muted">{emptyMessage}</p> : emptyMessage}
      </div>
    );
  }

  return (
    <ul className="arcade-list">
      {items.map((scored) => {
        const a = scored.arcade;
        return (
          <li
            key={a.id}
            className={a.id === selectedId ? 'is-selected' : ''}
            onClick={() => onSelect(a.id)}
          >
            <div className="arcade-head">
              {/*
                제목이 곧 이 줄을 여는 버튼입니다 (접근성 P1).

                줄 전체(`<li onClick>`)는 마우스 편의로 남겨 두되, **키보드와
                보조기술에는 진짜 버튼이 필요합니다.** 지도 마커는 구조상 보조기술로
                접근할 수 없어서(커스텀 오버레이 div), 이 목록이 오락실을 고르는
                유일한 대체 경로입니다 — 그 경로가 마우스 전용이면 지도 전체가
                접근 불가가 됩니다 (docs/PERF-A11Y-REPORT.md P1).

                `<li>` 를 통째로 <button> 으로 감싸지 않는 이유: 안에 즐겨찾기·수정·
                삭제 버튼이 들어 있어 버튼 중첩이 됩니다.
              */}
              <h3>
                <button
                  type="button"
                  className="row-title"
                  onClick={(e) => {
                    // 줄 클릭과 겹쳐 두 번 불리지 않게 막는다
                    e.stopPropagation();
                    onSelect(a.id);
                  }}
                >
                  {a.name}
                </button>
              </h3>
              {scored.distanceKm !== null && (
                <span className="distance">{formatDistance(scored.distanceKm)}</span>
              )}
              {canFavorite && (
                <button
                  type="button"
                  className={`fav-btn ${isFavorite(a.id) ? 'is-on' : ''}`}
                  aria-pressed={isFavorite(a.id)}
                  title={isFavorite(a.id) ? '즐겨찾기에서 빼기' : '즐겨찾기에 담기'}
                  onClick={(e) => {
                    // 행 전체가 '선택' 이다 — 별을 눌렀는데 상세까지 열리면
                    // 담기만 하려던 사람의 화면이 통째로 바뀐다.
                    e.stopPropagation();
                    onToggleFavorite(a.id);
                  }}
                >
                  {isFavorite(a.id) ? '★' : '☆'}
                </button>
              )}
            </div>

            <p className="address">{a.address}</p>
            {/* 할 말이 하나도 없으면 줄을 만들지 않는다 (빈 줄이 카드 간격만 늘린다) */}
            {(hours(a) !== null || a.phone || a.reviewCount > 0) && (
              <p className="hours">
                {[
                  hours(a),
                  a.phone,
                ]
                  .filter(Boolean)
                  .map((part, i) => (
                    <span key={part as string} className={i > 0 ? 'dot-sep' : undefined}>
                      {part}
                    </span>
                  ))}
                {a.reviewCount > 0 && (
                  <span className="dot-sep rating-inline">
                    <StarRating value={a.ratingAvg} />
                    {a.ratingAvg?.toFixed(1)} ({a.reviewCount})
                  </span>
                )}
              </p>
            )}

            {a.machines.length > 0 && (
              <div className="badges">
                {/* 점 하나 = 기체 한 대. 2대인데 한 대만 빨간 점이면 목록에서
                    바로 보인다 — 기종당 점 하나로 뭉치면 그게 사라진다. */}
                {a.machines.map((m) => (
                  <span
                    key={m.id}
                    className={`badge badge-${m.category}`}
                    title={[
                      `${m.name} · ${m.cabinetCount}대`,
                      ...m.cabinets.map((c) => {
                        const v = cabinetCondition(c);
                        return `${c.cabinetNo}호기 ${v === null ? '컨디션 모름' : `${v}/5`}`;
                      }),
                    ].join(' · ')}
                  >
                    {m.shortName}
                    {m.cabinetCount > 1 && <em>×{m.cabinetCount}</em>}
                    {m.cabinets.map((c) => {
                      const v = cabinetCondition(c);
                      return v === null ? null : <i key={c.id} className={`cond cond-${v}`} />;
                    })}
                  </span>
                ))}
              </div>
            )}

            {/* TTL 안의 대기 제보가 있는 기종만. 목록에서 "지금 갈 수 있나"가 먼저 보여야 한다. */}
            {a.machines.some((m) => m.live && m.live.waitCount !== null) && (
              <div className="wait-row">
                {a.machines
                  .filter((m) => m.live && m.live.waitCount !== null)
                  .map((m) => (
                    <span key={m.id} className="wait-item">
                      <span className="wait-name">{m.shortName}</span>
                      <WaitBadge live={m.live} cabinets={m.cabinetCount} compact />
                    </span>
                  ))}
              </div>
            )}

            {a.note && <p className="note">{a.note}</p>}

            {/*
              업체가 등록한 홈페이지·SNS. 예전에는 이 주소가 출처 문자열과 함께
              `note` 에 **원본 그대로** 찍혀 카드에서 세 줄을 차지했다 (migrate-055).
              행 전체가 '선택' 이므로 링크를 눌렀을 때 상세까지 열리지 않게 막는다.
            */}
            {isHttpUrl(a.homepage) && (
              <p className="ext-link">
                <a
                  href={a.homepage as string}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  onClick={(e) => e.stopPropagation()}
                >
                  홈페이지 · SNS
                </a>
              </p>
            )}

            {/* 관리자의 수정·삭제와 선택 해제가 같은 줄에 앉는다. 해제는
                선택된 행에만, 오른쪽 끝에 — 행을 다시 눌러도 해제되지
                않으므로(재선택이다) 끄는 버튼이 따로 있어야 한다. 누르면
                지도 강조가 꺼지고 평범한 좌표 마커만 남는다. */}
            {(canEdit || a.id === selectedId) && (
              <div className="row-actions">
                {canEdit && (
                  <>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        onEdit(a);
                      }}
                    >
                      수정
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(a);
                      }}
                    >
                      삭제
                    </button>
                  </>
                )}
                {a.id === selectedId && (
                  <button
                    type="button"
                    className="btn btn-sm unselect-btn"
                    title="선택 해제 — 지도의 강조 표시를 끕니다"
                    onClick={(e) => {
                      e.stopPropagation();
                      onClearSelect();
                    }}
                  >
                    위치 찾기 취소
                  </button>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
