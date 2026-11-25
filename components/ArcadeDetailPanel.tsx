'use client';

import { memo, useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import {
  REPORT_KIND_LABEL,
  WAIT_CHOICES,
  timeAgo,
  waitChoiceLabel,
  waitCountLabel,
  type MachineReport,
  type PresenceOutcome,
  type ReportKind,
  REPORT_COMMENT_MAX,
} from '@/lib/community-types';
import { reportOutcomeMessage, waitShownAt } from '@/lib/report-display';
import { placeLinks } from '@/lib/place-links';
import type {
  Arcade,
  ArcadeCabinet,
  ArcadeMachine,
  DataSource,
  Machine,
  MachineGuess,
} from '@/lib/types';
import { useFavorites } from '@/lib/use-favorites';
import { usePlayerId } from '@/lib/use-player';
import { useIsAdmin } from '@/lib/use-session';
import ArcadeInfoReport from './ArcadeInfoReport';
import ArcadeReviews from './ArcadeReviews';
import SourceNote, { machineSources } from './SourceNote';
import { ConditionBadge, WaitBadge } from './LiveBadge';

interface Props {
  arcade: Arcade;
  machines: Machine[];
  onClose: () => void;
  /**
   * 지도를 이 오락실로 다시 옮긴다.
   *
   * 주변을 보다가 화면이 그 지점에서 벗어나면 상세만 열려 있고 "어디였는지" 를
   * 볼 길이 없다. 지도가 접혀 있는 폭에서는 부모가 사이드바를 접어 지도를
   * 드러낸다 (ArcadeFinder handleLocate).
   */
  onLocate: () => void;
  /** 제보로 보유 기종/평점이 바뀌면 목록·지도도 같이 갱신되어야 한다 */
  onArcadeChanged: (arcade: Arcade) => void;
}

/**
 * 열려 있는 제보 폼 하나.
 *
 * 대기는 기종에, 컨디션은 기체에 달린다 — 그래서 같은 기종 안에서 1호기 폼과
 * 2호기 폼이 서로 다른 폼이어야 하고, 키에 cabinetId 가 들어간다.
 */
type OpenForm =
  | { kind: 'queue'; machineId: number }
  | { kind: 'condition'; machineId: number; cabinetId: number }
  | null;

function sameForm(a: OpenForm, b: OpenForm): boolean {
  if (!a || !b || a.kind !== b.kind || a.machineId !== b.machineId) return false;
  return a.kind === 'condition' && b.kind === 'condition' ? a.cabinetId === b.cabinetId : true;
}

/**
 * 제보 결과가 뜨는 자리. 예전에는 상세 맨 위 한 곳에 떠서, 아래쪽 카드에서 누른
 * 사람은 결과를 못 보거나 어느 게임 얘기인지 몰랐다 (2026-11-20 UX 시험 R-1).
 * 누른 자리(그 게임 블록 · '이 게임 있어요' 줄) 바로 아래에 띄운다.
 * 문구는 lib/report-display.ts reportOutcomeMessage.
 */
type RowMsg = { at: number | 'presence'; text: string; tone: 'notice' | 'warn' } | null;

function RowMessage({ msg }: { msg: RowMsg }) {
  if (!msg) return null;
  return (
    <p className={`${msg.tone} row-msg`} role={msg.tone === 'warn' ? 'alert' : 'status'}>
      {msg.text}
    </p>
  );
}

/**
 * 대기 제보 버튼에 넣을 값 — '대기 3명으로 알리기'. 누르기 전에 무엇이 나갈지 보인다.
 * '12명+' 는 뒤에 조사를 붙일 수 없어 '12명 이상' 으로 읽는다. 그러면 없음·N명·이상
 * 모두 받침으로 끝나 조사가 늘 '으로' 다.
 */
function waitSubmitLabel(count: number): string {
  const label = waitChoiceLabel(count);
  return `대기 ${label.endsWith('+') ? `${label.slice(0, -1)} 이상` : label}으로 알리기`;
}

/** 연결이 끊겨 fetch 자체가 못 나간 경우의 고정 문구 (docs/DESIGN-GUIDE.md §4) */
const NETWORK_ERROR = '연결이 잠깐 끊겼어요. 다시 시도해 주세요';

/**
 * memo 인 이유: 부모(ArcadeFinder)는 GPS 좌표·지도 이동(idle)·검색어 타이핑마다
 * 다시 렌더되는데, 이 패널의 재료(arcade·machines)는 그때 바뀌지 않는다.
 * 상세를 열어 둔 채 지도를 끌면 기종 행 + 기체 카드 + 제보 20건 + 리뷰가
 * 렌더마다 통째로 다시 그려지던 것이 "상세가 열려 있을 때만 무겁다" 의 정체였다.
 * 조건: 내려오는 콜백(onClose·onArcadeChanged)이 useCallback 이어야 한다.
 */
export default memo(ArcadeDetailPanel);

function ArcadeDetailPanel({
  arcade,
  machines,
  onClose,
  onLocate,
  onArcadeChanged,
}: Props) {
  const playerId = usePlayerId();
  const isAdmin = useIsAdmin();
  const favorites = useFavorites();

  const [reports, setReports] = useState<MachineReport[]>([]);
  const [open, setOpen] = useState<OpenForm>(null);
  const [memo, setMemo] = useState('');
  /**
   * 대기·컨디션 모두 **고른 다음 등록** 합니다 — 고르는 순간 전송하면 그 아래
   * 메모 칸에 뭘 쓸 기회가 없습니다. 대기가 드롭다운이 된 뒤로는 더 그렇습니다:
   * 목록을 훑다 스친 값이 그대로 제보가 되면 안 됩니다.
   */
  const [draftCondition, setDraftCondition] = useState<number | null>(null);
  const [draftWait, setDraftWait] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * AI 가 찾아낸 보유 기종 추정 (migrate-061). 확정이 아니라 "이거 맞나요?" 를
   * 물을 재료입니다. 상세를 열었을 때만 부릅니다 — 목록 쿼리에 얹으면 상세를
   * 열지 않는 대다수가 그 값을 치릅니다 (lib/arcades.ts listMachineGuesses).
   */
  const [guesses, setGuesses] = useState<MachineGuess[]>([]);
  /** "AI로 게임 찾기" 가 도는 중인가 — 검색 두 번에 몇 초가 걸려 단추를 잠가야 합니다 */
  const [guessing, setGuessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newMachineId, setNewMachineId] = useState<number | ''>('');
  /** 제보 결과 · 오류를 누른 자리에 띄운다 (RowMsg) */
  const [rowMsg, setRowMsg] = useState<RowMsg>(null);
  /**
   * '정말 없어졌나요?' 를 묻고 있는 게임. 예전에는 한 번 누르면 곧바로 접수됐고
   * 되돌릴 길이 없었다 — 실수 몇 번이면 실제로 있는 게임이 목록에서 빠진다 (R-1).
   * 묻는 동안에는 다른 제보 폼을 닫는다 (한 번에 입력 창 하나 — DESIGN-GUIDE §1-2).
   */
  const [confirmGone, setConfirmGone] = useState<number | null>(null);

  /**
   * 키보드 · 낭독기 (2026-11-20 UX 시험 C-3). 상세가 열리면 제목으로 초점을 옮겨
   * 무엇이 열렸는지 읽히게 하고, 패널은 그 제목을 이름으로 하는 region 이 된다.
   * 닫은 뒤 연 단추로 초점을 돌려주는 일은 부모(ArcadeFinder)가 한다 — 이 패널은
   * 닫히면 사라지므로 돌아갈 곳을 기억할 수 없다.
   */
  const titleId = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    titleRef.current?.focus();
  }, [arcade.id]);

  /**
   * Esc 는 안쪽부터 하나씩 닫는다 — 없어졌나요 확인 → 열린 제보 폼 → 상세.
   * 패널 안에 초점이 있을 때만 듣는다(문서 전체에 걸면 도우미 같은 다른 창의 Esc 까지 가로챈다).
   */
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    e.preventDefault();
    if (confirmGone !== null) setConfirmGone(null);
    else if (open !== null) {
      // 폼이 사라지면 그 안의 초점도 사라지므로 제목으로 옮겨 둔다
      setOpen(null);
      titleRef.current?.focus();
    } else onClose();
  };

  const loadReports = useCallback(async () => {
    try {
      const res = await fetch(`/api/arcades/${arcade.id}/reports?limit=20`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? '최근 제보를 불러오지 못했어요. 다시 시도해 주세요');
      setReports((data.reports as MachineReport[]) ?? []);
    } catch (e) {
      // fetch 가 못 나가면 TypeError('Failed to fetch') 다 — 영어 원문을 그대로 띄우지 않는다
      setError(
        e instanceof TypeError
          ? NETWORK_ERROR
          : e instanceof Error
            ? e.message
            : '최근 제보를 불러오지 못했어요. 다시 시도해 주세요',
      );
    }
  }, [arcade.id]);

  useEffect(() => {
    let alive = true;
    setGuesses([]);
    fetch(`/api/arcades/${arcade.id}/guesses`)
      .then((r) => r.json())
      .then((d) => {
        if (alive) setGuesses((d.guesses as MachineGuess[]) ?? []);
      })
      // 추정을 못 불러와도 상세는 그대로 보여야 합니다 — 있으면 좋은 것이지
      // 이 화면이 서는 근거가 아닙니다.
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [arcade.id]);

  useEffect(() => {
    setOpen(null);
    setNotice(null);
    setError(null);
    setRowMsg(null);
    setConfirmGone(null);
    setNewMachineId('');
    void loadReports();
  }, [loadReports]);

  const submit = async (body: {
    machineId: number;
    kind: ReportKind;
    cabinetId?: number | null;
    waitCount?: number | null;
    condition?: number | null;
  }) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    setRowMsg(null);
    setConfirmGone(null);
    // 결과는 누른 자리에 — '이 게임 있어요' 는 고르는 줄 아래, 나머지는 그 게임 블록 아래
    const at: number | 'presence' = body.kind === 'presence' ? 'presence' : body.machineId;
    const owned = arcade.machines.find((m) => m.id === body.machineId);
    const machineName =
      owned?.shortName ?? machines.find((m) => m.id === body.machineId)?.shortName ?? '이';
    const cabinetNo =
      body.cabinetId != null
        ? (owned?.cabinets.find((c) => c.id === body.cabinetId)?.cabinetNo ?? null)
        : null;
    try {
      const res = await fetch(`/api/arcades/${arcade.id}/reports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // playerId 를 싣지 않는다 — 로그인했는지는 세션 쿠키가 말하고, 없으면
        // 서버가 익명(null)으로 받는다. 제보만은 로그인을 요구하지 않는다.
        body: JSON.stringify({
          comment: memo.trim() || null,
          cabinetId: null,
          waitCount: null,
          condition: null,
          ...body,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setRowMsg({
          at,
          tone: 'warn',
          text: data.error ?? '제보를 보내지 못했어요. 다시 시도해 주세요',
        });
        return;
      }

      const outcome = data.outcome as PresenceOutcome;
      const nextArcade = (data.arcade as Arcade | null) ?? null;
      const text = reportOutcomeMessage({
        kind: body.kind,
        machineName,
        cabinetNo,
        waitCount: body.waitCount ?? null,
        outcome,
        support: data.support?.count ?? 0,
        need: data.support?.threshold ?? 2,
        // 서버가 세션으로 정한 값이 응답의 report.playerId 에 있다 — 화면의 로그인 상태보다 정확하다
        anonymous: (data.report?.playerId ?? null) === null,
        liveAfter: nextArcade?.machines.find((m) => m.id === body.machineId)?.live ?? null,
      });
      // 목록에서 빠지면 그 게임 블록이 사라지므로 맨 위에 띄운다
      if (outcome === 'removed') setNotice(text);
      else setRowMsg({ at, tone: 'notice', text });
      setOpen(null);
      setMemo('');
      setDraftCondition(null);
      setDraftWait(null);
      setNewMachineId('');
      if (nextArcade) onArcadeChanged(nextArcade);
      await loadReports();
    } catch {
      setRowMsg({ at, tone: 'warn', text: NETWORK_ERROR });
    } finally {
      setBusy(false);
    }
  };

  /**
   * 제보 삭제 — 관리자만. 지운 뒤 목록을 다시 받는다: 전국 피드와 달리 여기는
   * 20건짜리 고정 목록이라, 한 줄이 빠지면 그 자리를 다음 제보가 채워야 한다.
   */
  const removeReport = async (r: MachineReport) => {
    if (!confirm(`${r.machineShortName} 제보를 지울까요? 되돌릴 수 없어요.`)) return;
    setError(null);
    setNotice(null);
    const res = await fetch(`/api/reports/${r.id}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) {
      const data = await res.json().catch(() => null);
      setError(data?.error ?? '제보를 지우지 못했어요. 다시 시도해 주세요');
      return;
    }
    setNotice('제보를 지웠어요. 이미 반영된 게임 목록은 오락실 수정에서 고쳐 주세요');
    await loadReports();
  };

  /**
   * 이 한 곳만 검색해 추정을 만든다. 결과는 곧바로 위 추정 상자에 뜬다.
   * 실패 사유를 나눠 말합니다 — '검색이 안 돌았다'(다시 누르면 될 수 있음)와
   * '검색은 됐는데 근거가 없다'(다시 눌러도 같을 것)는 다음 행동이 다릅니다.
   */
  const runGuess = async () => {
    setGuessing(true);
    setError(null);
    setNotice(null);
    setRowMsg(null);
    try {
      const res = await fetch(`/api/arcades/${arcade.id}/guesses`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? '검색하지 못했어요. 잠시 뒤 다시 시도해 주세요');
        return;
      }
      setGuesses((data.guesses as MachineGuess[]) ?? []);
      /*
        found 는 검색이 찾은 수, fresh 는 그중 상자에 실제로 뜨는 수입니다. 이미
        제보로 확정된 기종은 추정 목록에서 빠지므로(lib/arcades.ts listMachineGuesses)
        둘이 다를 수 있고, 전부 겹치면 상자가 아예 뜨지 않습니다. 그 경우 "게임 3개를
        찾았어요" 라고만 말하면 아무것도 안 나온 화면과 어긋나 검색이 헛돈 것처럼
        보입니다 — 실은 이미 아는 것과 맞아떨어진, 나쁘지 않은 결과입니다.
      */
      const found = Number(data.found ?? 0);
      const fresh = Number(data.fresh ?? 0);
      const already = found - fresh;
      if (data.reused) {
        // 내가 누르기 전에 이미 돌려 본 곳이다. 검색은 나가지 않았고 한도도 쓰지 않았다.
        setNotice(
          fresh > 0
            ? '전에 찾아 둔 게임이 있어서 바로 보여 드려요'
            : '전에 찾아본 곳이에요. 찾은 게임이 모두 이미 목록에 있어요',
        );
      } else if (!data.searched) {
        setNotice('검색이 되지 않아 게임을 찾지 못했어요. 잠시 뒤 다시 눌러 주세요');
      } else if (found === 0) {
        setNotice('검색해 봤지만 근거가 있는 게임은 찾지 못했어요. 다녀왔다면 아래에서 알려 주세요');
      } else if (fresh === 0) {
        setNotice(`게임 ${found}개를 찾았는데, 모두 이미 목록에 있어요`);
      } else if (already > 0) {
        setNotice(
          `게임 ${found}개를 찾았어요. ${already}개는 이미 목록에 있어서 새로 찾은 ${fresh}개만 보여 드려요`,
        );
      } else {
        setNotice(`게임 ${found}개를 찾았어요. 맞다면 아래에서 알려 주세요`);
      }
    } catch {
      setError(NETWORK_ERROR);
    } finally {
      setGuessing(false);
    }
  };

  const toggleForm = (next: NonNullable<OpenForm>) => {
    setMemo('');
    setDraftCondition(null);
    setDraftWait(null);
    setNotice(null);
    setError(null);
    setRowMsg(null);
    setConfirmGone(null);
    setOpen((prev) => (sameForm(prev, next) ? null : next));
  };

  /** '없어졌다고 알리기' 를 누르면 곧바로 보내지 않고 그 자리에서 한 번 묻는다 */
  const toggleConfirmGone = (machineId: number) => {
    setOpen(null);
    setNotice(null);
    setError(null);
    setRowMsg(null);
    setConfirmGone((prev) => (prev === machineId ? null : machineId));
  };

  const ownedIds = new Set(arcade.machines.map((m) => m.id));
  const missing = machines.filter((m) => !ownedIds.has(m.id));
  const links = placeLinks(arcade);

  return (
    <div
      className="detail arcade-detail"
      role="region"
      aria-labelledby={titleId}
      onKeyDown={onKeyDown}
    >
      <div className="detail-head">
        {/*
          닫기 묶음을 DOM 에서 **제목보다 앞에** 둔다 — 열리면 초점이 제목에 오므로
          Shift+Tab 한 번이 '닫기' 다. 예전에는 목록에서 Tab 26번을 지나야 닫을 수 있었다
          (2026-11-20 UX 시험 C-3). 보이는 자리는 그대로 오른쪽(globals.css UX-2026-11 상세 · 제보).
        */}
        <div className="detail-head-actions">
          {/*
            비로그인에는 별을 그리지 않는다. 즐겨찾기는 계정에 붙는 값이라
            (app/api/favorites 가 세션에서 playerId 를 읽는다) 담아 둘 곳이 없다.
          */}
          {favorites.canFavorite && (
            <button
              type="button"
              className={`fav-btn fav-btn-lg ${favorites.isFavorite(arcade.id) ? 'is-on' : ''}`}
              aria-pressed={favorites.isFavorite(arcade.id)}
              // 별 글자만 있는 단추라 이름이 따로 있어야 한다 (docs/DESIGN-GUIDE.md §3-6)
              aria-label={
                favorites.isFavorite(arcade.id) ? '즐겨찾기에서 빼기' : '즐겨찾기에 담기'
              }
              title={
                favorites.isFavorite(arcade.id) ? '즐겨찾기에서 빼기' : '즐겨찾기에 담기'
              }
              onClick={() => void favorites.toggle(arcade.id)}
            >
              {favorites.isFavorite(arcade.id) ? '★' : '☆'}
            </button>
          )}
          <button type="button" className="btn btn-sm" onClick={onClose} title="상세 닫기 (Esc)">
            닫기
          </button>
        </div>
        <div className="detail-title">
          {/* 이름 오른쪽에 붙인다 — '이 지점' 을 가리키는 버튼이라 이름과 한 덩어리다 */}
          <div className="detail-title-row">
            <h2 id={titleId} ref={titleRef} tabIndex={-1}>
              {arcade.name}
            </h2>
            <button
              type="button"
              className="btn btn-sm locate-btn"
              title="지도를 이 오락실로 옮겨요"
              onClick={onLocate}
            >
              지도에서 보기
            </button>
          </div>
          <p className="muted small">{arcade.address}</p>
          {/*
            목록은 모르는 영업시간을 아예 말하지 않는다(ArcadeList hours). 대신
            여기서는 '정보 없음' 까지 알려 준다 — 상세는 그 한 곳을 보러 온 화면이라
            "안 적혀 있다" 도 답이기 때문이다. 예전에는 상세에 영업시간 칸 자체가
            없어서, 목록은 미등록이라 하고 상세는 아무 말도 안 하는 상태였다.
          */}
          <p className="muted small detail-facts">
            <span>
              {/* 원문 영업시간(hoursText)이 있으면 그것을 씁니다 — 요일별 · 단서가 붙은 시간을
                  openTime · closeTime 한 구간으로 줄이면 틀린 말이 됩니다 (migrate-085). */}
              {arcade.is24h
                ? '24시간'
                : arcade.hoursText
                  ? arcade.hoursText
                  : arcade.openTime && arcade.closeTime
                    ? `${arcade.openTime} ~ ${arcade.closeTime}`
                    : '영업시간은 아직 몰라요'}
            </span>
            {arcade.phone && <span className="dot-sep">{arcade.phone}</span>}
            {arcade.homepage && /^https?:\/\//i.test(arcade.homepage) && (
              <span className="dot-sep">
                <a href={arcade.homepage} target="_blank" rel="noopener noreferrer nofollow">
                  홈페이지 · SNS
                </a>
              </span>
            )}
          </p>
          {/*
            정보가 다르면 이용자가 알려 준다 (migrate-087). 지도 앱 단추보다 위에 둔다 — 빈칸을
            채우는 길이 앱 안에 먼저 보여야 앱이 지도 앱으로 가는 중간 페이지가 되지 않는다.
          */}
          <ArcadeInfoReport
            key={arcade.id}
            arcadeId={arcade.id}
            hoursUnknown={!arcade.is24h && !arcade.hoursText && !(arcade.openTime && arcade.closeTime)}
          />
          {/*
            영업시간 · 전화 · 길찾기는 지도 앱으로 넘긴다 (lib/place-links.ts). 우리 데이터에는
            그 칸이 거의 비어 있는데(926곳 중 영업시간 1곳 · 전화 0곳), 상세에 바깥으로 나가는
            길이 하나도 없어서 "영업시간 정보 없음" 에서 막혔다 (2026-10-22 첫 사용자 점검).
          */}
          <p className="place-links">
            <span className="muted small">영업시간 · 전화</span>
            <a
              className="btn btn-sm"
              href={links.naver}
              target="_blank"
              rel="noopener noreferrer"
              title="네이버 지도에서 이 오락실을 검색합니다 (새 창)"
            >
              네이버 지도
            </a>
            <a
              className="btn btn-sm"
              href={links.kakao}
              target="_blank"
              rel="noopener noreferrer"
              title="카카오맵에서 이 오락실을 검색합니다 (새 창)"
            >
              카카오맵
            </a>
            <a
              className="btn btn-sm"
              href={links.directions}
              target="_blank"
              rel="noopener noreferrer"
              title="카카오맵 길찾기를 이 오락실을 목적지로 엽니다 (새 창)"
            >
              길찾기
            </a>
          </p>
        </div>
      </div>

      {notice && <p className="notice">{notice}</p>}
      {error && <p className="warn">{error}</p>}

      <div className="section">
        {arcade.machines.length === 0 ? (
          // 이 오락실의 기종을 아무도 아직 안 알려 줬다는 뜻이다. 바로 아래가
          // 제보 칸이므로, 없다는 말 대신 그 칸을 가리킨다.
          <p className="muted small">
            아직 아무도 게임을 알려 주지 않았어요. 여기서 본 게임을 아래에서 골라 알려 주세요
          </p>
        ) : null}

        {/*
          AI 추정. **확정 목록 바깥에** 둡니다 — 같은 줄에 섞으면 제보로 확인된
          기종과 기계가 찾아낸 것이 구분되지 않고, 그 순간 이 화면이 거짓말을
          시작합니다. 근거를 함께 보여 주는 것이 핵심입니다. 사람이 "이걸 왜
          그렇게 봤나" 를 읽을 수 있어야 맞다/아니다를 판단할 수 있습니다.
        */}
        {/*
          출시 전 테스트 기간이라 **누구나** 누를 수 있습니다. 한 번에 구글 검색
          1회가 나가는 유료 동작이라 서버가 하루 한도로 조입니다
          (app/api/arcades/[id]/guesses POST, GUESS_LIMIT_*).

          이미 추정이 있으면 관리자에게만 보입니다 — 일반 사용자가 눌러도 서버는
          검색하지 않고 있던 것을 돌려주므로, 보이는 단추가 아무 일도 하지 않는
          단추가 됩니다. 배치(scripts/guess-arcade-machines.mjs)와 같은 일을
          **이 한 곳에만** 합니다.
        */}
        {(isAdmin || guesses.length === 0) && (
          <div className="guess-actions">
            <button
              type="button"
              className="btn btn-sm"
              disabled={guessing}
              onClick={runGuess}
              title="AI가 인터넷 검색으로 이 오락실에 있는 게임을 찾아요"
            >
              {guessing ? '찾는 중…' : guesses.length > 0 ? 'AI로 다시 찾기' : 'AI로 게임 찾기'}
            </button>
            {/* 한도는 비용 사정이지만 사람에게는 "몇 번 누를 수 있나" 로 말한다 */}
            <span className="muted small">
              {isAdmin ? '관리자는 횟수 제한 없음' : '하루 한 번 쓸 수 있어요'}
            </span>
          </div>
        )}

        {guesses.length > 0 && (
          <div className="guess-box">
            <p className="guess-head">
              <span className="guess-tag">AI가 찾은 게임</span>
              검색으로 찾아서 틀릴 수 있어요. 다녀왔다면 아래에서 알려 주세요
            </p>
            <ul className="guess-list">
              {guesses.map((g) => (
                <li key={g.machineId}>
                  <strong>{g.shortName ?? g.name}</strong>
                  <span className="muted small">{g.evidence}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {arcade.machines.length === 0 ? null : (
          <ul className="live-list">
            {arcade.machines.map((m, i) => (
              <li key={m.id}>
                <MachineRow
                  machine={m}
                  sources={i === arcade.machines.length - 1 ? machineSources(arcade.machines) : null}
                  waitShownAt={waitShownAt(m.live, reports, m.id)}
                  msg={rowMsg?.at === m.id ? rowMsg : null}
                  confirmingGone={confirmGone === m.id}
                  onToggleGone={() => toggleConfirmGone(m.id)}
                  open={open}
                  busy={busy}
                  memo={memo}
                  onMemo={setMemo}
                  draftCondition={draftCondition}
                  onDraftCondition={setDraftCondition}
                  draftWait={draftWait}
                  onDraftWait={setDraftWait}
                  onToggle={toggleForm}
                  onSubmit={submit}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="section">
        {missing.length === 0 ? (
          <p className="muted small">고를 수 있는 게임이 모두 이미 목록에 있어요</p>
        ) : (
          <div className="presence-row">
            <select
              value={newMachineId}
              onChange={(e) => setNewMachineId(e.target.value ? Number(e.target.value) : '')}
              disabled={busy}
              aria-label="여기서 본 게임"
            >
              <option value="">게임 고르기</option>
              {/*
                칩·뱃지는 줄임말(사볼)인데 여기만 정식 명칭(SOUND VOLTEX)이라, 필터에서
                고른 게임을 이 목록에서 다시 찾아야 했다 (2026-09-13 UX 점검).
                줄임말을 앞에 두고 정식 명칭을 뒤에 붙여 양쪽 다 찾을 수 있게 한다.
              */}
              {missing.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.shortName === m.name ? m.name : `${m.shortName} · ${m.name}`}
                </option>
              ))}
            </select>
            {/* 상세 패널에 늘 보이는 줄이라 주 버튼 무게를 주지 않습니다 — 주 버튼은 지금 열린
                제보 폼 하나에만 (docs/DESIGN-GUIDE.md §1-2). 게임을 고르기 전에는 꺼져 있습니다. */}
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy || newMachineId === ''}
              onClick={() => submit({ machineId: Number(newMachineId), kind: 'presence' })}
            >
              {/* 제보 종류 이름(REPORT_KIND_LABEL.presence)과 같은 말 — 목록 빈 화면도 이 말을 부른다 */}
              이 게임 있어요 알리기
            </button>
          </div>
        )}
        <RowMessage msg={rowMsg?.at === 'presence' ? rowMsg : null} />
        <p className="hint">
          여러 사람이 알려 주면 게임 목록에 바로 반영돼요
          {!playerId && '. 익명 제보는 기록만 남고 반영 인원에는 세지 않아요'}
        </p>
      </div>

      <div className="section">
        {reports.length === 0 ? (
          <p className="muted small">아직 제보가 없어요. 다녀왔다면 위에서 알려 주세요</p>
        ) : (
          <ul className="feed feed-compact">
            {reports.map((r) => (
              <li key={r.id}>
                <span className={`kind kind-${r.kind}`}>{REPORT_KIND_LABEL[r.kind]}</span>
                <span className="feed-body">
                  <strong>
                    {r.machineShortName}
                    {/* 옛 제보는 어느 기체였는지 기록이 없어 번호가 비어 있다 */}
                    {r.cabinetNo !== null && <em className="feed-cabinet">{r.cabinetNo}호기</em>}
                  </strong>
                  {r.kind === 'queue' &&
                    r.waitCount !== null &&
                    ` 대기 ${waitCountLabel(r.waitCount)}`}
                  {r.kind === 'condition' && ` 상태 ${r.condition}/5`}
                  {r.comment && <em className="feed-memo">{r.comment}</em>}
                </span>
                <span className="muted small feed-meta">
                  {r.nickname ?? '익명'} · {timeAgo(r.createdAt)}
                  {isAdmin && (
                    <button
                      type="button"
                      className="btn btn-sm btn-danger feed-del"
                      title="이 제보 지우기"
                      onClick={() => void removeReport(r)}
                    >
                      지우기
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <ArcadeReviews arcade={arcade} onArcadeChanged={onArcadeChanged} />
    </div>
  );
}

// ─── 기종 1블록 ───────────────────────────────────────────────

/** MachineRow → CabinetCard 로 그대로 흘려보내는 제보 폼 상태 */
interface ReportFormProps {
  open: OpenForm;
  busy: boolean;
  memo: string;
  onMemo: (v: string) => void;
  draftCondition: number | null;
  onDraftCondition: (v: number | null) => void;
  draftWait: number | null;
  onDraftWait: (v: number | null) => void;
  onToggle: (next: NonNullable<OpenForm>) => void;
  onSubmit: (body: {
    machineId: number;
    kind: ReportKind;
    cabinetId?: number | null;
    waitCount?: number | null;
    condition?: number | null;
  }) => void;
}

/**
 * 기종 하나 = 헤더(대기) + 기체 카드 N장(컨디션).
 *
 * 대기는 기종에 한 번만 붙는다 — 줄은 게임 앞에 서지 호기별로 서지 않는다.
 * 반대로 컨디션은 카드마다 따로다: 1호기는 멀쩡한데 2호기 발판만 죽어 있는
 * 오락실이 흔한데, 기종에 컨디션 한 칸만 두면 그 사실을 적을 자리가 없다.
 */
function MachineRow({
  machine,
  waitShownAt: shownAt,
  msg,
  confirmingGone,
  onToggleGone,
  sources,
  ...form
}: {
  machine: ArcadeMachine;
  /** 마지막 카드에만 — 이 오락실 기종들의 출처를 한 번에 (나무위키 · CC BY-NC-SA) */
  sources: DataSource[] | null;
  /** 대기 뱃지 시각 — 보이는 인원을 알려 준 제보의 시각 (lib/report-display.ts) */
  waitShownAt: string | null;
  /** 이 게임에서 보낸 제보의 결과 · 오류 */
  msg: RowMsg;
  /** '정말 없어졌나요?' 를 묻는 중인가 */
  confirmingGone: boolean;
  onToggleGone: () => void;
} & ReportFormProps) {
  const { open, busy, memo, onMemo, draftWait, onDraftWait, onToggle, onSubmit } = form;
  const queueForm = { kind: 'queue', machineId: machine.id } as const;
  const queueOpen = sameForm(open, queueForm);
  const goneBtnRef = useRef<HTMLButtonElement>(null);
  const goneQuestionId = useId();

  /** 확인을 물리면 초점을 '없어졌다고 알리기' 로 돌려준다 — 묻던 상자가 사라져 초점이 갈 곳을 잃는다 */
  const cancelGone = () => {
    onToggleGone();
    goneBtnRef.current?.focus();
  };

  return (
    <div className="live-row">
      <div className="live-head">
        <span className={`badge badge-${machine.category}`}>
          {machine.shortName}
          {machine.cabinetCount > 1 && <em>×{machine.cabinetCount}</em>}
        </span>
        <WaitBadge live={machine.live} cabinets={machine.cabinetCount} shownAt={shownAt} />
      </div>

      <div className="live-actions">
        <button
          type="button"
          className={queueOpen ? 'btn btn-sm btn-on' : 'btn btn-sm'}
          onClick={() => onToggle(queueForm)}
        >
          대기 알리기
        </button>
      </div>

      {queueOpen && (
        <div className="report-form">
          <p className="muted small">
            지금 대기 중인 사람 수
            {machine.cabinetCount > 1 && (
              <span className="muted"> · {machine.cabinetCount}대 합쳐서</span>
            )}
          </p>
          {/* 0 은 유효한 값('없음')이므로 "안 고른 상태"를 0 으로 표현할 수 없다.
              빈 문자열 ↔ null 로 따로 둔다. */}
          <select
            value={draftWait ?? ''}
            disabled={busy}
            aria-label="대기 인원"
            onChange={(e) => onDraftWait(e.target.value === '' ? null : Number(e.target.value))}
          >
            <option value="">인원 고르기</option>
            {WAIT_CHOICES.map((n) => (
              <option key={n} value={n}>
                {waitChoiceLabel(n)}
              </option>
            ))}
          </select>
          <input
            type="text"
            placeholder="한 줄 메모 (선택)"
            aria-label="한 줄 메모"
            maxLength={REPORT_COMMENT_MAX}
            value={memo}
            onChange={(e) => onMemo(e.target.value)}
          />
          {/* 고른 값이 버튼에 들어간다 — 누르기 전에 무엇이 나갈지 보인다.
              그래서 옆에 따로 '먼저 고르세요 / 메모는 선택' 을 적지 않는다. */}
          <div className="form-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy || draftWait === null}
              onClick={() =>
                onSubmit({ machineId: machine.id, kind: 'queue', waitCount: draftWait })
              }
            >
              {draftWait === null ? '인원을 골라 주세요' : waitSubmitLabel(draftWait)}
            </button>
          </div>
        </div>
      )}

      <ul className="cabinet-list">
        {machine.cabinets.map((c) => (
          <li key={c.id}>
            <CabinetCard machine={machine} cabinet={c} {...form} />
          </li>
        ))}
      </ul>

      {/*
        '없어졌다고 알리기' 는 블록 맨 아래 글자 링크로 낮춘다. 예전에는 빨간 테두리
        버튼으로 '대기 알리기' 바로 옆에 있었고 한 번 누르면 곧바로 접수됐다
        (2026-11-20 UX 시험 R-1). 되돌릴 수 없는 쪽은 주 행동과 같은 줄에 두지 않는다
        (DESIGN-GUIDE §1-2). 누르면 그 자리에서 게임 이름을 넣어 한 번 더 묻는다.
      */}
      <div className="gone-row">
        <button
          ref={goneBtnRef}
          type="button"
          className="btn-link"
          disabled={busy}
          aria-expanded={confirmingGone}
          onClick={onToggleGone}
        >
          없어졌다고 알리기
        </button>
      </div>
      {confirmingGone && (
        <div
          className="report-form gone-confirm"
          role="group"
          aria-labelledby={goneQuestionId}
          onKeyDown={(e) => {
            // 상세의 Esc 보다 먼저 — 묻는 상자만 닫고 초점을 링크로 돌려준다
            if (e.key !== 'Escape' || e.defaultPrevented) return;
            e.preventDefault();
            cancelGone();
          }}
        >
          <p id={goneQuestionId} className="small">
            <strong>{machine.shortName} 게임이 정말 없어졌나요?</strong> 여러 사람이 알려 주면 이
            오락실 게임 목록에서 빠져요
          </p>
          <div className="form-actions">
            <button
              type="button"
              className="btn btn-sm btn-danger"
              disabled={busy}
              onClick={() => onSubmit({ machineId: machine.id, kind: 'absence' })}
            >
              {machine.shortName} 없어졌다고 알리기
            </button>
            {/* 기본 초점은 물리는 쪽 — Enter 한 번에 접수되지 않게 */}
            <button type="button" className="btn-link" autoFocus onClick={cancelGone}>
              그대로 두기
            </button>
          </div>
        </div>
      )}

      <RowMessage msg={msg} />
      {sources && <SourceNote sources={sources} />}
    </div>
  );
}

// ─── 기체 1대 ─────────────────────────────────────────────────

function CabinetCard({
  machine,
  cabinet,
  open,
  busy,
  memo,
  onMemo,
  draftCondition,
  onDraftCondition,
  onToggle,
  onSubmit,
}: { machine: ArcadeMachine; cabinet: ArcadeCabinet } & ReportFormProps) {
  const form = { kind: 'condition', machineId: machine.id, cabinetId: cabinet.id } as const;
  const isOpen = sameForm(open, form);

  return (
    <div className={isOpen ? 'cabinet-card is-open' : 'cabinet-card'}>
      <div className="cabinet-head">
        <span className="cabinet-no">{cabinet.cabinetNo}호기</span>
        {/* 등록값과 제보를 종합한 숫자 하나. 등록값도 제보도 없을 때만 비는데,
            그때는 빈칸이 아니라 "모름"이라고 적는다 — 빈칸은 상태가 좋다는
            뜻으로 읽히기 쉽다. */}
        <ConditionBadge summary={cabinet.conditionSummary} />
        {cabinet.conditionSummary === null && (
          <span className="muted small">상태는 아직 몰라요</span>
        )}
        <button
          type="button"
          className={isOpen ? 'btn btn-sm btn-on cabinet-btn' : 'btn btn-sm cabinet-btn'}
          onClick={() => onToggle(form)}
        >
          상태 알리기
        </button>
      </div>

      {isOpen && (
        <div className="report-form">
          <p className="muted small">
            {cabinet.cabinetNo}호기 상태 (5 = 최상)
            {draftCondition !== null && <strong className="picked"> {draftCondition}점 고름</strong>}
          </p>
          {/* 대기와 달리 누르면 '선택'만 된다. 등록은 아래 버튼으로 —
              그 사이에 메모를 쓸 수 있어야 하기 때문이다. */}
          <div className="preset-row">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                className={draftCondition === n ? 'btn btn-sm btn-on' : 'btn btn-sm'}
                disabled={busy}
                aria-pressed={draftCondition === n}
                onClick={() => onDraftCondition(draftCondition === n ? null : n)}
              >
                {n}
              </button>
            ))}
          </div>
          <input
            type="text"
            placeholder="한 줄 메모 (선택)"
            aria-label="한 줄 메모"
            maxLength={REPORT_COMMENT_MAX}
            value={memo}
            onChange={(e) => onMemo(e.target.value)}
          />
          {/* 대기 폼과 같다 — 고른 점수가 버튼에 들어가므로 옆 안내는 두지 않는다 */}
          <div className="form-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy || draftCondition === null}
              onClick={() =>
                onSubmit({
                  machineId: machine.id,
                  kind: 'condition',
                  cabinetId: cabinet.id,
                  condition: draftCondition,
                })
              }
            >
              {draftCondition === null
                ? '상태를 골라 주세요'
                : `${cabinet.cabinetNo}호기 상태 ${draftCondition}점으로 알리기`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
