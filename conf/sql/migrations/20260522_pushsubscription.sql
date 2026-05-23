--
-- Migration: pushsubscription — stores browser Web Push subscriptions so the
-- OGN daemon can notify users about competition class-status changes (task set,
-- launching, racing, finishing) even when their browser is closed.
--
-- endpoint is the real push-service URL (the daemon needs it to send) and
-- contains a secret token, so it is never put in a request URL. endpointhash
-- (SHA-256 hex of endpoint) is the safe lookup key used by the status and
-- unsubscribe endpoints — it can appear in a GET query string and logs without
-- leaking the token.
--
-- A subscription's target is the tuple (compid, targetclass, targetcompno).
-- Both target columns empty ('') means "the whole competition" — the only kind
-- the current feature writes. The columns exist now so a future per-class or
-- per-pilot subscription is just a row with targetclass / targetcompno set,
-- with no schema change. They are NOT NULL DEFAULT '' rather than nullable so
-- the uniqsub UNIQUE key (and INSERT ... ON DUPLICATE KEY UPDATE) works — a
-- MySQL UNIQUE index treats NULLs as distinct, breaking dedup.
--
-- This migration is NOT re-runnable — running it twice fails with
-- "Table 'pushsubscription' already exists". Run once per database.
--

CREATE TABLE `pushsubscription` (
  `id`            int unsigned NOT NULL AUTO_INCREMENT,
  `endpoint`      varchar(512) NOT NULL COMMENT 'browser push service endpoint URL (contains a secret token)',
  `endpointhash`  char(64)     NOT NULL COMMENT 'SHA-256 hex of endpoint — safe lookup key for status/unsubscribe',
  `p256dh`        varchar(128) NOT NULL COMMENT 'client public key for payload encryption',
  `auth`          varchar(64)  NOT NULL COMMENT 'client auth secret for payload encryption',
  `compid`        varchar(40)  NOT NULL COMMENT 'competition this subscription follows',
  `targetclass`   varchar(64)  NOT NULL DEFAULT '' COMMENT '"" = whole competition; reserved for future per-class',
  `targetcompno`  varchar(16)  NOT NULL DEFAULT '' COMMENT '"" = whole competition; reserved for future per-pilot',
  `lang`          char(8)      NOT NULL DEFAULT 'en' COMMENT 'subscriber UI language — notification text is built in this language',
  `expiresat`     datetime     NOT NULL COMMENT 'safety-net expiry (after the comp end date)',
  `created`       datetime     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniqsub` (`endpoint`(255), `compid`, `targetclass`, `targetcompno`),
  KEY `idx_compid` (`compid`),
  KEY `idx_endpointhash` (`endpointhash`),
  KEY `idx_expiresat` (`expiresat`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COMMENT='Web Push subscriptions for competition status notifications';
