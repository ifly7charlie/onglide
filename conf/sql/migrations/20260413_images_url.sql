--
-- Migration: images.url
--
-- Adds the `url` column used by lib/scoring/shared/images.ts to remember
-- the URL a pilot portrait was last successfully downloaded from. On
-- refresh the image worker prefers this column over guessing
-- /PilotImages/{id}.jpg, so we no longer hammer the FAI site with 404s
-- for pilots whose real filename differs from the id-based guess.
--
-- Safe to re-run: ALTER TABLE … ADD COLUMN IF NOT EXISTS is MariaDB 10.0+
-- and MySQL 8.0+. If your MySQL is older, drop the IF NOT EXISTS clause.
--

ALTER TABLE `images`
    ADD COLUMN IF NOT EXISTS `url` VARCHAR(256) DEFAULT NULL
        COMMENT 'source URL of the last successful download, used as the preferred candidate on refresh'
        AFTER `updated`;
