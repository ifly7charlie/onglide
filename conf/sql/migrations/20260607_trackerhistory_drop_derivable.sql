--
-- Migration: trackerhistory — drop derivable score columns
--
-- The within-comp prior is now built ONLY from each day's start/finish line
-- crossings (`delta_start` / `delta_finish`) via `crossingScore`. The composite
-- score, its margin, and the ddb link are all recomputed live on every scan
-- (from the ddb feed and the flarm_* identity tables), so persisting them here
-- only duplicated state that goes stale. Drop them:
--
--   pair_score — total log-likelihood (nats); recomputed each run
--   margin     — min(pilotMargin, flarmidMargin); recomputed each run
--   ddb_link   — which DDB facets matched; read live from the ddb feed
--
-- The crossing deltas remain — they are the only per-day evidence not derivable
-- from another source, and the prior loader rebuilds its score from them.
--
-- DROP COLUMN IF EXISTS keeps the migration idempotent — re-running is a no-op.
--

ALTER TABLE `trackerhistory`
    DROP COLUMN IF EXISTS `pair_score`,
    DROP COLUMN IF EXISTS `margin`,
    DROP COLUMN IF EXISTS `ddb_link`;
