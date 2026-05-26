--
-- Migration: compstatus.laststatuschange — UTC timestamp of the most recent
-- transition of compstatus.status to a new value. Maintained by BEFORE INSERT
-- and BEFORE UPDATE triggers, so any writer that hits the table picks up the
-- bookkeeping automatically without each call site having to remember.
--
-- The UPDATE trigger uses null-safe equality (<=>): if status doesn't change
-- value (including same-NULL), laststatuschange is preserved, so callers that
-- write the same status repeatedly don't keep bumping the timestamp.
--
-- NOTE: ADD COLUMN IF NOT EXISTS is not valid in MySQL (only MariaDB).
-- This migration is NOT re-runnable. Run once per database.
--

ALTER TABLE `compstatus`
    ADD COLUMN `laststatuschange` datetime DEFAULT NULL
        COMMENT 'UTC time the status column last transitioned to a new value (maintained by triggers)'
        AFTER `status`;

-- Backfill existing rows so the column isn't NULL forever for classes that
-- haven't transitioned since the migration. UTC_TIMESTAMP() is the best we
-- can do — we don't know when the current value was actually set.
UPDATE `compstatus` SET `laststatuschange` = UTC_TIMESTAMP() WHERE `laststatuschange` IS NULL;

DROP TRIGGER IF EXISTS `compstatus_laststatuschange_ins`;
CREATE TRIGGER `compstatus_laststatuschange_ins`
BEFORE INSERT ON `compstatus`
FOR EACH ROW
SET NEW.laststatuschange = UTC_TIMESTAMP();

DROP TRIGGER IF EXISTS `compstatus_laststatuschange_upd`;
CREATE TRIGGER `compstatus_laststatuschange_upd`
BEFORE UPDATE ON `compstatus`
FOR EACH ROW
SET NEW.laststatuschange = IF(NOT (NEW.status <=> OLD.status), UTC_TIMESTAMP(), OLD.laststatuschange);
