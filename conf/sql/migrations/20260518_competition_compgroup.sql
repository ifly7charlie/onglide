--
-- Migration: competition.compgroup — optional group key. A competition with a
-- compgroup is shown only to clients subscribed to the matching /all/<group>
-- websocket feed; the bare /all feed still sees every competition. NULL means
-- ungrouped (visible only on bare /all).
--
-- NOTE: ADD COLUMN IF NOT EXISTS is not valid in MySQL (only MariaDB).
-- This migration is NOT re-runnable — running it a second time will fail
-- with "Duplicate column name 'compgroup'". Run once per database.
--

ALTER TABLE `competition`
    ADD COLUMN `compgroup` varchar(40) DEFAULT NULL
        COMMENT 'optional group key; restricts visibility on the /all/<group> feed'
        AFTER `compid`;
