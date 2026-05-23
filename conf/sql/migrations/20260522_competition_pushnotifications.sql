--
-- Migration: competition.pushnotifications — per-competition opt-in for Web
-- Push status notifications. 'N' (the default) hides the subscribe bell and
-- makes /api/push/subscribe reject new subscriptions; 'Y' enables the feature
-- for that competition. The daemon also filters sends on this flag, so setting
-- it back to 'N' stops notifications even for already-subscribed browsers.
--
-- NOTE: ADD COLUMN IF NOT EXISTS is not valid in MySQL (only MariaDB).
-- This migration is NOT re-runnable. Run once per database.
--

ALTER TABLE `competition`
    ADD COLUMN `pushnotifications` char(1) DEFAULT 'N'
        COMMENT 'Y = Web Push status notifications enabled for this competition'
        AFTER `delayseconds`;
