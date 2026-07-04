--
-- Migration: competition.disable — operator switch to hide a competition.
-- 'N' (the default) leaves the comp visible and scored as normal; 'Y' makes
-- ogn.ts skip it entirely — it is neither displayed on the /all feed nor
-- loaded for scoring/tracking.
--
-- NOTE: ADD COLUMN IF NOT EXISTS is not valid in MySQL (only MariaDB).
-- This migration is NOT re-runnable. Run once per database.
--

ALTER TABLE `competition`
    ADD COLUMN `disable` char(1) DEFAULT 'N'
        COMMENT 'Y = competition is hidden: not displayed or loaded by ogn.ts'
        AFTER `pushnotifications`;
