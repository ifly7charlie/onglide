-- Path-similarity evidence table.
-- Stores the result of comparing two FlarmID tracks for the same pilot to
-- determine whether they represent the same physical flight (same aircraft,
-- two trackers) or genuinely different flights.
--
-- Keyed on canonical pair order (flarmid_a < flarmid_b by ASCII) so (A,B)
-- and (B,A) always map to the same row.  The UNIQUE KEY lets findtrackers
-- upsert on every re-run without accumulating duplicates.
--
-- Column types match the conventions of `trackerhistory` (compno char(4),
-- class char(15), datecode char(3)) and the identity tables (flarmid char(6)).

CREATE TABLE IF NOT EXISTS `trackerhistory_paths` (
  `id`                  int(11)     NOT NULL AUTO_INCREMENT,
  `compno`              char(4)     NOT NULL,
  `class`               char(15)    NOT NULL,
  `datecode`            char(3)     NOT NULL,
  `flarmid_a`           char(6)     NOT NULL COMMENT 'canonical lower of the pair (ASCII)',
  `flarmid_b`           char(6)     NOT NULL COMMENT 'canonical higher of the pair',
  `kind`                enum('same_flight','different_flight','insufficient_data') NOT NULL,
  `classification`      varchar(30) DEFAULT NULL COMMENT 'ShapeReport classification kind',
  `p95_pos_km`          float       DEFAULT NULL COMMENT 'deltaPosP95Km from ShapeReport',
  `alt_bias_m`          float       DEFAULT NULL COMMENT 'altBiasM from ShapeReport',
  `lag_sec`             smallint    DEFAULT NULL COMMENT 'estimated lag between the two streams',
  `overlap_sec`         int(11)     DEFAULT NULL COMMENT 'seconds of mutual sample overlap',
  `aborted_after_quick` tinyint(1)  NOT NULL DEFAULT 0,
  `changed`             datetime    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_path` (`compno`, `class`, `datecode`, `flarmid_a`, `flarmid_b`),
  KEY `idx_class_datecode` (`class`, `datecode`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
