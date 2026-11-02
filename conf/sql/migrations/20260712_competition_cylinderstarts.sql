--
-- Migration: competition.cylinderstarts
--
-- Adds a competition-level opt-in for IGC cylinder (PEV) starts (SC3 Annex A
-- 7.4.4). When set to 'Y', the ssscrape task-install path
-- (lib/scoring/shared/tasks.ts) inspects the start observation zone of every
-- task it installs for the competition's classes:
--   * a full start cylinder of radius >= 10km auto-enables tasks.pevstart='Y'
--     (the OGN daemon then estimates the start inside the cylinder);
--   * a full start cylinder smaller than 10km is a misconfiguration for a
--     cylinder-start competition -- it is logged and the start OZ is rewritten
--     as a start line;
--   * a start line or partial sector is left unchanged (pevstart='N').
-- A competition without this flag keeps the existing manual per-task pevstart.
--
-- NOTE: ADD COLUMN IF NOT EXISTS is not valid in MySQL (only MariaDB), so it is
-- not used here. This migration is NOT re-runnable. Run once per database.
--

ALTER TABLE `competition`
    ADD COLUMN `cylinderstarts` char(1) DEFAULT 'N'
        COMMENT 'Y = competition supports IGC cylinder (PEV) starts; ssscrape auto-enables tasks.pevstart for a >=10km full start cylinder and converts a smaller full cylinder to a line'
        AFTER `flightstats`;
