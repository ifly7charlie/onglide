--
-- Migration: competition.trackingconsent
--
-- Adds a per-competition opt-in flag for livetracking. When 'Y', the
-- competition has obtained explicit consent from its pilots and the
-- DDB Permit-Livetracking ('tracked') flag is bypassed when matching
-- unknown gliders / writing trackerids. When 'N' (the default), any
-- DDB record (OGN or FlarmNet) with tracked != 'Y' will cause the
-- pilot's trackerid to be set to the 'blocked' sentinel.
--

ALTER TABLE `competition`
    ADD COLUMN IF NOT EXISTS `trackingconsent` CHAR(1) DEFAULT 'N'
        COMMENT 'Y = comp has obtained explicit livetracking consent from pilots; bypass DDB tracked=N block';
