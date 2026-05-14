--
-- Migration: trackerhistory — score-evidence columns + index
--
-- Adds the per-day pair-score and decision-context columns that
-- bin/findtrackers.ts now records for every (compno, flarmid) candidate
-- it evaluates. These rows persist through to the next day's scan as
-- multi-day prior evidence (decayed exponentially on the task-day
-- timeline).
--
-- All new columns are NULL-able with no default behaviour change so the
-- 9 existing INSERT call sites (matchtrackers.ts, ogn.ts, findtrackers.ts,
-- soaringspot.ts, ssscrape.ts, launchlanding.ts) keep working unchanged.
--
-- Columns:
--   class         — class scope (NULL on legacy rows)
--   datecode      — comp day code (NULL on legacy rows)
--   delta_start   — signed seconds, scan-crossing − official; NULL when no start crossing
--   delta_finish  — signed seconds; NULL when no finish crossing
--   pair_score    — total log-likelihood ratio (nats) for this pair on this day
--   margin        — min(pilotMargin, flarmidMargin) at decision time
--   ddb_link      — which DDB facets matched (CN, glider type, both, none)
--
-- Index:
--   idx_class_datecode_method covers (a) bulk prior-load
--   "WHERE class=? AND datecode<? AND method NOT IN (blocked)" and
--   (b) the per-day idempotent DELETE for evidence rows
--   "WHERE class=? AND datecode=? AND method='evidence'".
--
-- ADD COLUMN/INDEX IF NOT EXISTS keeps the migration idempotent on
-- MySQL 8.4 — re-running is a no-op.
--

ALTER TABLE `trackerhistory`
    ADD COLUMN `class`        char(15)  NULL,
    ADD COLUMN  `datecode`     char(3)   NULL,
    ADD COLUMN  `delta_start`  smallint  NULL,
    ADD COLUMN  `delta_finish` smallint  NULL,
    ADD COLUMN  `pair_score`   float     NULL,
    ADD COLUMN  `margin`       float     NULL,
    ADD COLUMN  `ddb_link`     enum('none','cn','glider','both') NOT NULL DEFAULT 'none',
    ADD INDEX   `idx_class_datecode_method` (`class`, `datecode`, `method`);
