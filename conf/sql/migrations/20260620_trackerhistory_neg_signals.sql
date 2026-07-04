-- Diag data for negative evidence signals: distance from line and coverage gap
-- at the official start/finish time. Persisted alongside existing crossing deltas
-- so that wrong-time-crossing / confirmed-absent penalties accumulate in the prior
-- over consecutive competition days.
-- NULL when the tracker had no usable position data near the official line time.
ALTER TABLE trackerhistory
    ADD COLUMN dist_at_start   FLOAT NULL AFTER delta_finish,
    ADD COLUMN gap_around_start FLOAT NULL AFTER dist_at_start,
    ADD COLUMN dist_at_finish  FLOAT NULL AFTER gap_around_start,
    ADD COLUMN gap_around_finish FLOAT NULL AFTER dist_at_finish;
