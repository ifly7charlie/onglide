--
-- Migration: competition.urllogo — URL to a logo image displayed alongside
-- the competition name on the landing-page list and the per-competition
-- tracking page header. Clicking the logo on the tracking page goes to
-- competition.mainwebsite.
--
-- NOTE: ADD COLUMN IF NOT EXISTS is not valid in MySQL (only MariaDB).
-- This migration is NOT re-runnable — running it a second time will fail
-- with "Duplicate column name 'urllogo'". Run once per database.
--

ALTER TABLE `competition`
    ADD COLUMN `urllogo` varchar(512) DEFAULT NULL
        COMMENT 'URL to competition logo image; shown on list & tracking pages'
        AFTER `mainwebsite`;
