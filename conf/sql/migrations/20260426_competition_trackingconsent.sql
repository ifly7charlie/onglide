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
-- Safe to re-run: the INFORMATION_SCHEMA guard skips the ALTER if the
-- column already exists. Avoids `ADD COLUMN IF NOT EXISTS`, which is
-- MariaDB-only and rejected by stock MySQL 8.
--

SET @col_exists := (
    SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name   = 'competition'
      AND column_name  = 'trackingconsent'
);

SET @ddl := IF(@col_exists = 0,
    'ALTER TABLE `competition`
        ADD COLUMN `trackingconsent` CHAR(1) DEFAULT ''N''
            COMMENT ''Y = comp has obtained explicit livetracking consent from pilots; bypass DDB tracked=N block''',
    'SELECT 1');

PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
