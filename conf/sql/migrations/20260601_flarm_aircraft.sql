--
-- Migration: cross-competition identity evidence tables
--
-- Three new tables that persist across competitions (unlike tracker /
-- trackerhistory, which are keyed on the transient classid and cleaned up at
-- comp end). The FLARM id is the aircraft; pilots are clues. Evidence is
-- collected only from confident findtrackers matches and never for DDB-blocked
-- devices. No raw pilot names or club names are stored — only keyed HMAC
-- hashes (IDENTITY_HMAC_SECRET). See lib/scoring/shared/identity.ts.
--
--   flarm_aircraft         — one row per flarmid: glider key, greg, country,
--                            comp number, ICAO-permanence flag, observation
--                            count and first/last seen.
--   flarm_pilot            — one row per (flarmid, distinct pilot clue): club
--                            hash, real FAI, observations. A club glider flown
--                            by N pilots yields N rows.
--   flarm_pilot_nametoken  — HMAC name tokens per clue; idx_token serves the
--                            part-2 reverse lookup (find flarmids by name).
--
-- CREATE TABLE IF NOT EXISTS keeps the migration idempotent — re-running is a
-- no-op. bin/findtrackers.ts tolerates these tables being absent (warn-once,
-- then skip collection/usage) so a scan still runs before the migration lands.
--

CREATE TABLE IF NOT EXISTS `flarm_aircraft` (
  `flarmid` char(6) NOT NULL COMMENT 'uppercase 6-hex device id (the aircraft)',
  `glider_key` varchar(16) DEFAULT NULL COMMENT 'gliderEquivalent key() of glider type (not sensitive)',
  `greg` char(12) DEFAULT NULL COMMENT 'normalised registration when pilot.greg present (public)',
  `country` char(2) DEFAULT NULL COMMENT 'resolved 2-letter country',
  `compno` char(4) DEFAULT NULL COMMENT 'most-recently-observed comp number (weak — usually consistent, not unique)',
  `is_icao_id` char(1) DEFAULT 'N' COMMENT 'Y when the flarmid is the aircraft permanent ICAO 24-bit address',
  `observations` int(11) NOT NULL DEFAULT '1',
  `first_seen` datetime DEFAULT NULL,
  `last_seen` datetime DEFAULT NULL,
  PRIMARY KEY (`flarmid`),
  KEY `idx_greg` (`greg`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COMMENT='Cross-comp flarmid->aircraft evidence; no raw names/clubs';

CREATE TABLE IF NOT EXISTS `flarm_pilot` (
  `flarmid` char(6) NOT NULL,
  `pilot_key` char(32) NOT NULL COMMENT 'HMAC over (sorted name token hashes + fai + country); dedupes one crew',
  `club_hash` char(32) DEFAULT NULL COMMENT 'HMAC of normalised home club; never the raw club',
  `fai` int(11) DEFAULT NULL COMMENT 'real FAI id only (>0 and <300000)',
  `observations` int(11) NOT NULL DEFAULT '1',
  `first_seen` datetime DEFAULT NULL,
  `last_seen` datetime DEFAULT NULL,
  PRIMARY KEY (`flarmid`,`pilot_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COMMENT='Cross-comp pilot clues per flarmid (a club glider yields many)';

CREATE TABLE IF NOT EXISTS `flarm_pilot_nametoken` (
  `flarmid` char(6) NOT NULL,
  `pilot_key` char(32) NOT NULL,
  `token_hash` char(32) NOT NULL COMMENT 'HMAC of one normalised name token; partial overlap = partial match',
  PRIMARY KEY (`flarmid`,`pilot_key`,`token_hash`),
  KEY `idx_token` (`token_hash`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COMMENT='Per-clue HMAC name tokens; idx_token serves part-2 reverse lookup';
