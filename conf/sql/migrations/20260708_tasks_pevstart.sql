--
-- Migration: tasks.pevstart
--
-- Adds the `pevstart` flag for the IGC Cylinder (PEV) start (SC3 Annex A
-- 7.4.4). When set, the OGN daemon estimates each pilot's start as the top
-- of the last climb before a committed glide toward TP1 inside the start
-- cylinder (PEV button presses are invisible to OGN tracking), and task /
-- leg-1 distances are measured from that credited fix instead of the ring.
--
-- No upstream feed (SoaringSpot / SGP) carries this concept, so the flag is
-- set manually per task; lib/scoring/shared/tasks.ts preserves it across
-- task re-imports. The start leg itself must be a cylinder (taskleg legno 0:
-- type='sector', a1=180) for the flag to take effect.
--
-- NOTE: ADD COLUMN IF NOT EXISTS is not valid in MySQL (only MariaDB), so it
-- is not used here. This migration is NOT re-runnable. Run once per database.
--

ALTER TABLE `tasks`
    ADD COLUMN `pevstart` enum('Y','N') DEFAULT 'N'
        COMMENT 'Y = IGC cylinder (PEV) start: estimate start from track behaviour inside the start cylinder'
        AFTER `nostart`;
