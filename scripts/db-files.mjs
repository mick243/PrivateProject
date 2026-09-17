/**
 * SQL 파일 목록 — 스크립트(init-db · migrate)가 공유합니다.
 *
 * ⚠ 이 세 목록은 `lib/db.ts` 와 같아야 합니다. 스크립트는 `.ts` 를 import 할 수
 *   없어서 옮겨 적은 것이고, `tests/db-lists.test.ts` 가 둘을 대조합니다.
 *   `lib/db.ts` 를 고치면 여기도 고치세요 — 어긋나면 **조용히** 어긋납니다
 *   (2026-08-24 에 030~036 이 빠진 채 이력만 남아 데이터가 비어 있었습니다).
 */

// 적용 순서 = lib/db.ts 의 SQL_GROUPS 와 동일.
// tier 는 machines 를, community/board 는 arcades + players/charts 를 참조한다.
export const SCHEMA_GROUPS = [
  { sentinel: 'arcades', files: ['schema.sql', 'seed.sql'] },
  { sentinel: 'charts', files: ['schema-tier.sql', 'seed-tier.sql'] },
  { sentinel: 'chart_comments', files: ['schema-community.sql', 'seed-community.sql'] },
  { sentinel: 'post_likes', files: ['schema-board.sql', 'seed-board.sql'] },
  { sentinel: 'post_images', files: ['schema-board-images.sql'] },
];

export const SCHEMA_FILES = SCHEMA_GROUPS.flatMap((g) => g.files);

// 이미 적용된 스키마를 고치는 변경 (lib/db.ts MIGRATION_FILES).
// 새로 만든 DB 는 시드에 이미 최종 상태가 있어 아무 일도 하지 않지만, 이력을
// 남겨야 서버가 뜰 때 다시 실행하지 않는다.
export const MIGRATION_FILES = [
  'migrate-001-machine-list.sql',
  'migrate-002-cabinets.sql',
  'migrate-003-queue-ttl.sql',
  'migrate-004-admin.sql',
  'migrate-005-piu-songs.sql',
  'migrate-006-piu-pro2-m.sql',
  'migrate-007-piu-artists.sql',
  'migrate-008-oauth-identities.sql',
  'migrate-009-arcade-source.sql',
  'migrate-010-strip-corporate-form.sql',
  'migrate-011-queue-ttl-4h.sql',
  'migrate-012-piu-s1-tier.sql',
  'migrate-013-drop-seed-piu-tiers.sql',
  'migrate-014-tier-scale-rework.sql',
  'migrate-015-notice-category.sql',
  'migrate-016-post-body-doc.sql',
  'migrate-017-arcade-favorites.sql',
  'migrate-018-piu-s2-tier.sql',
  'migrate-019-piu-remix-shortcut-fullsong.sql',
  'migrate-020-restore-saranga-chart.sql',
  'migrate-021-piu-remix-text-list.sql',
  'migrate-022-drop-novasonic-novarash-remix.sql',
  'migrate-023-drop-remix-subset.sql',
  'migrate-024-drop-remix-subset-2.sql',
  'migrate-025-drop-remix-subset-3.sql',
  'migrate-026-oauth-nickname.sql',
  'migrate-027-nickname-ci-unique.sql',
  'migrate-028-piu-s3-tier.sql',
  'migrate-029-fix-s3-final-audition.sql',
  'migrate-030-piu-s4-tier.sql',
  'migrate-031-piu-s5-tier.sql',
  'migrate-032-piu-s6-tier.sql',
  'migrate-033-piu-all-charts.sql',
  'migrate-034-vote-scale-0.1.sql',
  'migrate-035-grade-band-tiebreak.sql',
  'migrate-036-chart-tag-rework.sql',
  'migrate-037-notice-without-game.sql',
  'migrate-038-add-machines.sql',
  'migrate-039-condition-window-30d.sql',
  'migrate-040-chart-special-flag.sql',
  'migrate-041-special-marks-consensus.sql',
  'migrate-042-posts-scale-indexes.sql',
  'migrate-043-sdvx-8-tier.sql',
  'migrate-044-tier-chart-basis.sql',
  'migrate-045-mode-is-difficulty.sql',
  'migrate-046-sdvx-chart-tags.sql',
  'migrate-047-sdvx-17-tier.sql',
  'migrate-048-drop-sdvx-17-off-sheet.sql',
  'migrate-049-verse-iv-a-tier.sql',
  'migrate-050-player-email.sql',
  'migrate-051-email-verification.sql',
  'migrate-052-login-failures.sql',
  'migrate-053-queue-purge-index.sql',
  'migrate-054-rate-counters.sql',
  'migrate-055-arcade-homepage.sql',
  'migrate-056-fk-player-indexes.sql',
  'migrate-057-token-epoch.sql',
  'migrate-058-chart-level-notation.sql',
  'migrate-059-ez2dj-6th-trax-tier.sql',
  'migrate-060-ez2dj-7th-trax-tier.sql',
  'migrate-061-machine-guesses.sql',
  'migrate-062-emoticons.sql',
  'migrate-063-imported-news.sql',
  'migrate-064-emoticons-soft-delete.sql',
  'migrate-065-chart-video.sql',
  'migrate-066-chart-video-piu-s4.sql',
  'migrate-067-chart-video-piu-s1-s3.sql',
  'migrate-068-chart-video-nakaka-s19.sql',
  'migrate-069-chart-video-86-s20.sql',
  'migrate-070-chart-video-piu-s4-rest.sql',
  'migrate-071-chart-video-piu-s4-others.sql',
  'migrate-072-chart-video-piu-s4-manual.sql',
  'migrate-073-review-summaries.sql',
];

// 파생 객체(뷰). 테이블이 다 만들어진 뒤 마지막에.
export const DERIVED_SQL_FILE = 'views.sql';

/** lib/db.ts MIGRATION_LOCK_KEY 와 같은 값 — 서버와 스크립트가 같은 잠금을 잡아야 합니다 */
export const MIGRATION_LOCK_KEY = 72_028_531;

export const MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name       TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );`;
