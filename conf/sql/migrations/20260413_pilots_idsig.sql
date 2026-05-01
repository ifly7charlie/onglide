--
-- Migration: pilots.idsig
--
-- Adds the `idsig` column used by the scoring scheduler
-- (lib/scoring/shared/pilots.ts) to gate FAI ranking-list re-resolution.
-- Without this column the column-list INSERT in upsertPilot will fail.
--
-- Safe to re-run: ALTER TABLE … ADD COLUMN IF NOT EXISTS is MariaDB 10.0+
-- and MySQL 8.0+. If your MySQL is older, drop the IF NOT EXISTS clause.
--

ALTER TABLE `pilots`
    ADD COLUMN IF NOT EXISTS `idsig` VARCHAR(64) DEFAULT NULL
        COMMENT 'hash of fullName|compno used by the scoring scheduler to gate FAI re-resolution; only re-resolved when sig changes'
        AFTER `fai`;
