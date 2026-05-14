--
-- Migration: trackerhistory.method — add 'evidence' and 'startmatch-swap'
--
-- Two new method values introduced by the probabilistic scoring system:
--   evidence         — daily per-pair score row written by bin/findtrackers.ts
--                      for every (compno, flarmid) candidate above the
--                      ledger floor (DEFAULT_LEDGER_MIN_NATS = 0.5 nats).
--                      These rows are the multi-day prior fuel: tomorrow's
--                      scan reads them, decays each by task-days-ago, and
--                      adds the result to today's pair_score.
--   startmatch-swap  — both halves of a pilot↔pilot swap applied when
--                      Hungarian assignment finds a strictly-better
--                      pairing. Reserved here so we don't have to ALTER
--                      the prod table again when Stage 4 lands.
--
-- MODIFY COLUMN with the full enum list is idempotent — re-running after
-- the values are present is a no-op.
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
        'ddb-blocked',
        'startmatch',
        'evidence',
        'startmatch-swap'
    ) DEFAULT 'none';
