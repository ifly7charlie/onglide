--
-- Migration: trackerhistory.method — add blocked-source values
--
-- Adds 'ogn-blocked', 'flarmnet-blocked', and 'ddb-blocked' to the
-- enum so we can record which DDB upstream(s) caused a pilot's tracker
-- to be set to the 'blocked' sentinel:
--   ogn-blocked      — only OGN reported tracked != 'Y'
--   flarmnet-blocked — only FlarmNet reported tracked != 'Y'
--   ddb-blocked      — both sources reported tracked != 'Y'
--
-- MODIFY COLUMN with the full enum list is idempotent — re-running the
-- migration after the values are present is a no-op.
--

ALTER TABLE `trackerhistory`
    MODIFY COLUMN `method` enum(
        'none',
        'startline',
        'pilot',
        'ognddb',
        'igcfile',
        'tltimes',
        'robocontrol',
        'grandprix',
        'soaringspot',
        'ogn-blocked',
        'flarmnet-blocked',
        'ddb-blocked'
    ) DEFAULT 'none';
