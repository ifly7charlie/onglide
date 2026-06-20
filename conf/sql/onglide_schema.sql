CREATE DATABASE ogn;
USE ogn;
--
--
-- Table structure for table `comprules`
--

--
-- Table structure for table `classes`
--

DROP TABLE IF EXISTS `classes`;
CREATE TABLE `classes` (
  `class` char(15) NOT NULL COMMENT 'hash of compid+raw class name, globally unique',
  `compid` varchar(40) NOT NULL COMMENT 'competition this class belongs to',
  `classname` char(30) NOT NULL,
  `description` varchar(200) DEFAULT '',
  `type` char(20) DEFAULT NULL,
  `handicapped` char(1) DEFAULT 'N',
  `grandprixstart` char(1) DEFAULT 'N',
  `Dm` float DEFAULT NULL,
  UNIQUE KEY `class` (`class`),
  KEY `compid` (`compid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

--
-- Table structure for table `compdayshelper`
--

DROP TABLE IF EXISTS `compdayshelper`;
CREATE TABLE `compdayshelper` (
  `year` int(11) DEFAULT NULL,
  `month` int(11) DEFAULT NULL,
  `day` int(11) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

--
-- Table structure for table `competition`
--

DROP TABLE IF EXISTS `competition`;
CREATE TABLE `competition` (
  `compid` varchar(40) NOT NULL COMMENT 'url-safe competition identifier, used in routing',
  `compgroup` varchar(40) DEFAULT NULL COMMENT 'optional group key; restricts visibility on the /all/<group> feed',
  `name` varchar(60) DEFAULT NULL COMMENT 'Competition name',
  `sitename` varchar(100) DEFAULT NULL COMMENT 'Site name',

  `start` date DEFAULT NULL COMMENT 'Displayed as date range',
  `end` date DEFAULT NULL,

  `countrycode` char(2) DEFAULT 'UK',

  `tzoffset` int(11) DEFAULT 7200 COMMENT 'TZ offset from GMT in seconds (calculated)',
  `tz` char(40) DEFAULT 'Europe/Stockholm' COMMENT 'TZ offset from SoaringSpot',

  `mainwebsite` varchar(240) DEFAULT NULL COMMENT 'Used when clicking on comp name to return to primary website',
  `urllogo` varchar(512) DEFAULT NULL COMMENT 'URL to competition logo image; shown on list & tracking pages',
  `lt` float DEFAULT NULL COMMENT 'launch/landing location',
  `lg` float DEFAULT NULL COMMENT 'launch/landing location',
  `flightstats` char(1) DEFAULT 'N' COMMENT 'Compute per-flight statistics (thermals, wind, etc.) - Y/N',
  `trackingconsent` char(1) DEFAULT 'N' COMMENT 'Y = comp has obtained explicit livetracking consent from pilots; bypass DDB tracked=N block',
  `delayseconds` int(11) DEFAULT NULL COMMENT 'official tracking delay in seconds; NULL = inherit NEXT_PUBLIC_COMPETITION_DELAY env (default 10)',
  `pushnotifications` char(1) DEFAULT 'N' COMMENT 'Y = Web Push status notifications enabled for this competition',
  `disable` char(1) DEFAULT 'N' COMMENT 'Y = competition is hidden: not displayed or loaded by ogn.ts',
  PRIMARY KEY (`compid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COMMENT='Main settings for the competition';

--
-- Table structure for table `compstatus`
--

DROP TABLE IF EXISTS `compstatus`;
CREATE TABLE `compstatus` (
  `class` char(15) NOT NULL,
  `datecode` char(3) DEFAULT NULL COMMENT 'current contest date code for this class',
  
  `status` char(1) DEFAULT '?' COMMENT 'what is happening with this class (?=prereg,:=no task this day,B=afterbrief,G=gridded,L=launched,S=startopen/flying,F=first finisher imminent,H=all home,Z=scrubbed,O=comp over',
  `laststatuschange` datetime DEFAULT NULL COMMENT 'UTC time the status column last transitioned to a new value (maintained by triggers below)',
  `resultsdatecode` char(3) DEFAULT NULL COMMENT 'what date is scoring up to with uploading, results after this date wont be displayed',
  `task` char(1) DEFAULT 'A' COMMENT 'selected task',

  `startheight` int(11) DEFAULT '0',
  `notes` text  COMMENT 'Headline message to display',
  UNIQUE KEY `class` (`class`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COMMENT='Current competition status, one row per class';

--
-- Triggers maintain compstatus.laststatuschange. The column is bumped only when
-- the status value actually changes — other UPDATEs (resultsdatecode, task,
-- notes, etc.) leave it alone. Defined here so a fresh schema install gets
-- them; the matching migration installs the same triggers on existing DBs.
--
DROP TRIGGER IF EXISTS `compstatus_laststatuschange_ins`;
CREATE TRIGGER `compstatus_laststatuschange_ins`
BEFORE INSERT ON `compstatus`
FOR EACH ROW
SET NEW.laststatuschange = UTC_TIMESTAMP();

DROP TRIGGER IF EXISTS `compstatus_laststatuschange_upd`;
CREATE TRIGGER `compstatus_laststatuschange_upd`
BEFORE UPDATE ON `compstatus`
FOR EACH ROW
SET NEW.laststatuschange = IF(NOT (NEW.status <=> OLD.status), UTC_TIMESTAMP(), OLD.laststatuschange);

--
-- Table structure for table `contestday`
--

DROP TABLE IF EXISTS `contestday`;
CREATE TABLE `contestday` (
  `class` char(15) NOT NULL DEFAULT '',
  `datecode` char(4) NOT NULL,
  `daynumber` int(11) NOT NULL DEFAULT '0' COMMENT 'Calculated at briefing for the day, may be more than one with same number',
  `calendardate` date DEFAULT NULL,
  `turnpoints` char(200) DEFAULT NULL COMMENT 'csv list of turnpoints',
  `tasktime` char(30) DEFAULT NULL COMMENT 'aat: length of task in time',
  `script` char(60) DEFAULT NULL COMMENT 'description of the task',
  `length` char(30) DEFAULT NULL COMMENT 'speed: distance',
  `result_type` char(30) DEFAULT 'Estimated' COMMENT 'output from scoring, is the result unconfirmed, etc',
  `results_uploaded` datetime DEFAULT NULL,
  `info` char(255) DEFAULT NULL COMMENT 'Messages output about the task',
  `status` char(1) DEFAULT 'N' COMMENT 'What happened with the day - Y = contest, Z = scrubbed, N = not yet flown',
  `comments` text ,
  `notes` text ,
  `igcavailable` char(1) DEFAULT 'N' COMMENT 'Are there any IGC files for this day Y/N',
  `windspeed` int(11) DEFAULT NULL COMMENT 'Used for UK Scoring script windicapping',
  `winddir` int(11) DEFAULT NULL COMMENT 'Used for UK Scoring script windicapping',
  PRIMARY KEY (`class`,`datecode`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;


--
-- Table structure for table `errorlog`
--

DROP TABLE IF EXISTS `errorlog`;
CREATE TABLE `errorlog` (
  `at` datetime NOT NULL,
  `msg` text,
  `page` text,
  `querycompno` char(4) DEFAULT NULL,
  `realusername` char(30) DEFAULT NULL,
  `queryuser` char(30) DEFAULT NULL,
  `extra1` text,
  `extra2` text
) ENGINE=InnoDB DEFAULT CHARSET=utf8;


--
-- Table structure for table `images`
--

DROP TABLE IF EXISTS `images`;
CREATE TABLE `images` (
  `class` char(15) NOT NULL,
  `compno` char(4) NOT NULL,
  `image` mediumblob,
  `updated` int(11) NOT NULL,
  `url` varchar(256) DEFAULT NULL COMMENT 'source URL of the last successful download, used as the preferred candidate on refresh',
  PRIMARY KEY (`class`,`compno`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1;

--
-- Table structure for table `logindetails`
--

DROP TABLE IF EXISTS `logindetails`;
CREATE TABLE `logindetails` (
  `username` varchar(160) NOT NULL DEFAULT '',
  `password` tinyblob,
  `displayname` char(60) DEFAULT NULL,
  `pilot` char(4) DEFAULT NULL,
  `type` char(1) NOT NULL,
  `mobilenumber` char(20) DEFAULT NULL,
  `blogable` char(1) DEFAULT 'Y',
  `originalpw` text,
  `mobilekey` text NOT NULL,
  PRIMARY KEY (`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

--
-- Table structure for table `msg`
--

DROP TABLE IF EXISTS `msg`;
CREATE TABLE `msg` (
  `msg` text
) ENGINE=InnoDB DEFAULT CHARSET=utf8;


--
-- Table structure for table `pilotresult`
--

-- This table 
DROP TABLE IF EXISTS `pilotresult`;
CREATE TABLE `pilotresult` (
  `class` char(15) NOT NULL,
  `datecode` char(3) NOT NULL,
  `compno` char(4) NOT NULL,
  `pilot` int(11) DEFAULT NULL,

  `start` time DEFAULT NULL COMMENT 'start time from scoring, overrides ogn determined one',
  `finish` time DEFAULT NULL COMMENT 'finish time from scoring, overrides ogn',
  `duration` time DEFAULT NULL COMMENT 'duration from start to finish, only set when a finish occurs in scoring',

  `status` char(1) DEFAULT NULL COMMENT 'pilot status, see table pilotstatushelper',
  `scoredstatus` char(1) DEFAULT 'S' COMMENT 'flight status from scoring, used with status, S=start,F=finish,H=home',

  `speed` float DEFAULT NULL COMMENT 'actual speed - scoring',
  `hspeed` float DEFAULT NULL COMMENT 'handicapped speed - scoring',
  `distance` float DEFAULT NULL COMMENT 'actual distance - scoring',
  `hdistance` float DEFAULT NULL COMMENT 'handicapped distance - scoring' ,

  `penalty` int(11) DEFAULT NULL COMMENT 'any penalty points - scoring',
  `daypoints` int(11) DEFAULT '0',
  `dayrank` int(11) DEFAULT NULL,
  `totalpoints` int(11) DEFAULT '0',
  `totalrank` int(11) DEFAULT NULL,
  `prevtotalrank` int(11) DEFAULT NULL,
  
  `igcavailable` char(1) DEFAULT 'Y' COMMENT 'is file for download - legacy',
  
  `datafromscoring` char(1) NOT NULL DEFAULT 'N' COMMENT 'results are from scoring',
  
  `forcetp` int(11) DEFAULT NULL COMMENT 'last turnpoint rounded, used by UI to override when a sector has not been detected due to poor coverage',
  `forcetptime` datetime DEFAULT NULL,
  
  `statuschanged` datetime DEFAULT NULL,
  
  PRIMARY KEY (`class`,`datecode`,`compno`),
  KEY `class` (`class`),
  KEY `datecode` (`datecode`),
  KEY `compno` (`compno`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COMMENT='Stores results for a pilot along with landout and status information';

--
-- Table structure for table `pilots`
--

DROP TABLE IF EXISTS `pilots`;
CREATE TABLE `pilots` (
  `class` char(15) NOT NULL COMMENT 'classid',
  `compno` char(4) NOT NULL,
  `fai` int(11) DEFAULT '0',
  `idsig` varchar(64) DEFAULT NULL COMMENT 'hash of fullName|compno used by the scoring scheduler to gate FAI re-resolution; only re-resolved when sig changes',
  `firstname` char(30) DEFAULT NULL,
  `lastname` char(30) DEFAULT NULL,
  `homeclub` char(80) DEFAULT NULL,

  `username` varchar(160) DEFAULT NULL,
  `email` varchar(160) DEFAULT NULL,
  
  `registered` char(1) DEFAULT 'N',
  `registereddt` datetime DEFAULT NULL,
  
  `p2` char(40) DEFAULT NULL,
  `p2fai` int(11) DEFAULT NULL,
  
  `glidertype` char(30) DEFAULT 'Unknown',
  `wingspan` float DEFAULT NULL,
  `handicap` double(4,1) DEFAULT NULL,
  `turbo` char(1) DEFAULT NULL,
  
  `participating` char(1) DEFAULT NULL COMMENT 'Y=participant,N=H/C,W=withdrawn',

  `country` char(2) DEFAULT 'GB',
  `image` varchar(20) DEFAULT NULL,
  
  `greg` char(8) DEFAULT NULL,
  `fairings` char(1) DEFAULT '?',
  `winglets` char(1) DEFAULT '?',
  `turbulator` char(1) DEFAULT '?',
  `flarm` char(1) DEFAULT NULL,
  `mauw` int(11) DEFAULT NULL,
  PRIMARY KEY (`class`,`compno`),
  UNIQUE KEY `username` (`username`),
  KEY `fai` (`fai`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;


--
-- Table structure for table `soaringspotkey`
--

DROP TABLE IF EXISTS `scoringsource`;
CREATE TABLE `scoringsource` (
  `compid` varchar(40) NOT NULL COMMENT 'competition this scoring source feeds',
  `type` enum('soaringspotkey','soaringspotscrape','rst','robocontrol','sgp','pictureurl') DEFAULT 'soaringspotkey',
  `url` text,
  `client_id` char(120) DEFAULT NULL,
  `secret` char(120) DEFAULT NULL,
  `contest_name` char(120) DEFAULT NULL,
  `overwrite` int(11) DEFAULT '0',
  `actuals` int(11) DEFAULT '1',
  `portoffset` int(11) DEFAULT '0',
  `domain` text,
  KEY `compid` (`compid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

--
-- Table structure for table `taskleg`
--

DROP TABLE IF EXISTS `taskleg`;
CREATE TABLE `taskleg` (
  `class` char(15) NOT NULL DEFAULT '',
  `datecode` char(3) NOT NULL,
  `taskid` int(11) NOT NULL COMMENT 'links to tasks table',
  `legno` int(11) NOT NULL DEFAULT '0' COMMENT '0=start,1=tp1 etc',

  `ntrigraph` char(4) DEFAULT NULL COMMENT 'trigraph/short name for tp',
  `nname` char(80) DEFAULT NULL COMMENT 'long name for tp',

  `length` float DEFAULT NULL COMMENT 'leg length km',
  `bearing` int(11) DEFAULT NULL,
  `nlat` float DEFAULT NULL COMMENT 'location of tp',
  `nlng` float DEFAULT NULL COMMENT 'location of tp',
  `altitude` float default 0 comment 'altitude of the tp',
  `Hi` float DEFAULT NULL COMMENT 'handicap/windicap adjustment for the leg',

  `type` enum('sector','line','thistle') DEFAULT NULL COMMENT 'sector type',
  `direction` enum('fixed','np','symmetrical','pp','sp') DEFAULT NULL COMMENT 'how the center of the sector is calculated - SeeYou',
  `r1` float DEFAULT NULL COMMENT 'As per SeeYou settings',
  `a1` int(11) DEFAULT NULL COMMENT 'As per SeeYou settings',
  `r2` float DEFAULT NULL COMMENT 'As per SeeYou settings',
  `a2` int(11) DEFAULT NULL COMMENT 'As per SeeYou settings',
  `a12` float DEFAULT NULL COMMENT 'As per SeeYou settings',

  PRIMARY KEY (`taskid`,`legno`),
  KEY `class` (`class`,`datecode`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COMMENT='One row per TP, leg 0 is before start(tp0), 1 from start(tp0) to tp1, last is finish';

--
-- Table structure for table `tasks`
--

DROP TABLE IF EXISTS `tasks`;
CREATE TABLE `tasks` (
  `datecode` char(3) NOT NULL,
  `class` char(15) DEFAULT NULL,
  `taskid` int(11) NOT NULL AUTO_INCREMENT COMMENT 'Links to taskleg table',
  
  `task` char(1) DEFAULT NULL COMMENT 'Task letter, eg A B C',
  `flown` enum('Y','N') DEFAULT 'N' COMMENT 'Must be set to Y to be displayed!',
  `description` text,

  `type` enum('S','A','D','E','G') DEFAULT 'S' COMMENT 'Speed, AAT, Handicapped Distance, Eglide, SGP',

  `duration` time DEFAULT NULL COMMENT 'AAT time',
  `nostart` time DEFAULT NULL COMMENT 'Earliest possible start, starts before this are ignored',

  `hash` TEXT COMMENT 'hash of value from soaring spot to prevent redownloading',
  
  PRIMARY KEY (`taskid`),
  UNIQUE KEY `integrity` (`class`,`datecode`,`task`),
  KEY `class` (`class`)
) ENGINE=InnoDB AUTO_INCREMENT=1 DEFAULT CHARSET=utf8;

--
-- Table structure for table `tracker`
--

DROP TABLE IF EXISTS `tracker`;
CREATE TABLE `tracker` (
  `compno` char(4) NOT NULL,
  `type` enum('flarm','delorme','spot','none') DEFAULT NULL,
  `feedid` text,
  `password` text,
  `trackerid` text,
  `class` char(15) NOT NULL DEFAULT '',
  PRIMARY KEY (`class`,`compno`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

--
-- Table structure for table `trackerhistory`
--

DROP TABLE IF EXISTS `trackerhistory`;
CREATE TABLE `trackerhistory` (
  `compno` char(4) DEFAULT NULL,
  `changed` datetime DEFAULT NULL,
  `flarmid` text DEFAULT NULL,
  `flarmtype` char(3) DEFAULT NULL,
  `greg` char(12) DEFAULT NULL,
  `launchtime` time DEFAULT NULL,
  `method` enum('none','startline','pilot','ognddb','igcfile','tltimes','robocontrol','grandprix','soaringspot','ogn-blocked','flarmnet-blocked','ddb-blocked','startmatch','evidence','startmatch-swap','uncorrelated') DEFAULT 'none',
  `class` char(15) DEFAULT NULL,
  `datecode` char(3) DEFAULT NULL,
  `delta_start` smallint DEFAULT NULL,
  `delta_finish` smallint DEFAULT NULL,
  `dist_at_start` float DEFAULT NULL,
  `gap_around_start` float DEFAULT NULL,
  `dist_at_finish` float DEFAULT NULL,
  `gap_around_finish` float DEFAULT NULL,
  KEY `idx_class_datecode_method` (`class`, `datecode`, `method`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

--
-- Table structure for table `trackerhistory_paths`
--
-- Path-similarity evidence: the result of comparing two FlarmID tracks for the
-- same pilot to decide whether they are the same physical flight (one aircraft,
-- two trackers) or different flights. Keyed on canonical pair order
-- (flarmid_a < flarmid_b by ASCII) so (A,B) and (B,A) map to one row; the
-- UNIQUE KEY lets findtrackers upsert on every re-run. See
-- lib/scoring/shared/pathSimilarity.ts.
--

DROP TABLE IF EXISTS `trackerhistory_paths`;
CREATE TABLE `trackerhistory_paths` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `compno` char(4) NOT NULL,
  `class` char(15) NOT NULL,
  `datecode` char(3) NOT NULL,
  `flarmid_a` char(6) NOT NULL COMMENT 'canonical lower of the pair (ASCII)',
  `flarmid_b` char(6) NOT NULL COMMENT 'canonical higher of the pair',
  `kind` enum('same_flight','different_flight','insufficient_data') NOT NULL,
  `classification` varchar(30) DEFAULT NULL COMMENT 'ShapeReport classification kind',
  `p95_pos_km` float DEFAULT NULL COMMENT 'deltaPosP95Km from ShapeReport',
  `alt_bias_m` float DEFAULT NULL COMMENT 'altBiasM from ShapeReport',
  `lag_sec` smallint DEFAULT NULL COMMENT 'estimated lag between the two streams',
  `overlap_sec` int(11) DEFAULT NULL COMMENT 'seconds of mutual sample overlap',
  `aborted_after_quick` tinyint(1) NOT NULL DEFAULT 0,
  `changed` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_path` (`compno`, `class`, `datecode`, `flarmid_a`, `flarmid_b`),
  KEY `idx_class_datecode` (`class`, `datecode`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

--
-- Cross-competition identity evidence. Unlike `tracker`/`trackerhistory`
-- (keyed on the transient classid and cleaned up at comp end), these tables
-- persist across competitions: the FLARM id is the aircraft, accumulated from
-- confident findtrackers matches only, never for DDB-blocked devices. No raw
-- pilot names or club names are stored — only keyed HMAC hashes. See
-- lib/scoring/shared/identity.ts.
--

DROP TABLE IF EXISTS `flarm_aircraft`;
CREATE TABLE `flarm_aircraft` (
  `flarmid` char(6) NOT NULL COMMENT 'uppercase 6-hex device id (the aircraft)',
  `compid` varchar(40) NOT NULL COMMENT 'source competition — lets scoring exclude the current comp',
  `glider_key` varchar(48) DEFAULT NULL COMMENT 'gliderEquivalent key() of glider type (not sensitive; digitless names key to the full string)',
  `greg` char(12) DEFAULT NULL COMMENT 'normalised registration when pilot.greg present (public)',
  `country` char(2) DEFAULT NULL COMMENT 'resolved 2-letter country',
  `compno` char(4) DEFAULT NULL COMMENT 'comp number in this comp (weak — usually consistent, not unique)',
  `is_icao_id` char(1) DEFAULT 'N' COMMENT 'Y when the flarmid is the aircraft permanent ICAO 24-bit address',
  `match_score` float DEFAULT NULL COMMENT 'best physical-track match confidence (nats) this comp produced for this aircraft',
  `observations` int(11) NOT NULL DEFAULT '1',
  `first_seen` datetime DEFAULT NULL,
  `last_seen` datetime DEFAULT NULL,
  PRIMARY KEY (`flarmid`,`compid`),
  KEY `idx_greg` (`greg`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COMMENT='Cross-comp flarmid->aircraft evidence, per source comp; no raw names/clubs';

DROP TABLE IF EXISTS `flarm_pilot`;
CREATE TABLE `flarm_pilot` (
  `flarmid` char(6) NOT NULL,
  `pilot_key` char(32) NOT NULL COMMENT 'HMAC over (sorted name token hashes + fai hash + country); dedupes one crew',
  `compid` varchar(40) NOT NULL COMMENT 'source competition — lets scoring exclude the current comp',
  `club_hash` char(32) DEFAULT NULL COMMENT 'HMAC of normalised home club; never the raw club',
  `fai_hash` char(32) DEFAULT NULL COMMENT 'HMAC of a real FAI id (>0 and <300000); never the raw number',
  `match_score` float DEFAULT NULL COMMENT 'best physical-track match confidence (nats) this comp produced for this pilot+aircraft',
  `observations` int(11) NOT NULL DEFAULT '1',
  `first_seen` datetime DEFAULT NULL,
  `last_seen` datetime DEFAULT NULL,
  PRIMARY KEY (`flarmid`,`pilot_key`,`compid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COMMENT='Cross-comp pilot clues per flarmid, per source comp (a club glider yields many)';

DROP TABLE IF EXISTS `flarm_pilot_nametoken`;
CREATE TABLE `flarm_pilot_nametoken` (
  `flarmid` char(6) NOT NULL,
  `pilot_key` char(32) NOT NULL,
  `token_hash` char(32) NOT NULL COMMENT 'HMAC of one normalised name token; partial overlap = partial match',
  PRIMARY KEY (`flarmid`,`pilot_key`,`token_hash`),
  KEY `idx_token` (`token_hash`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COMMENT='Per-clue HMAC name tokens; idx_token serves part-2 reverse lookup';


DROP TABLE IF EXISTS `movements`;
CREATE TABLE `movements` (
  `action` char(10) NOT NULL COMMENT 'launch/landing',
  `time` int(11) NOT NULL COMMENT 'timestamp epoch',
  `id` char(40) NOT NULL,
  `type` enum('flarm','igc') DEFAULT NULL,
  `datecode` char(3) DEFAULT NULL,
  `compid` varchar(40) DEFAULT NULL COMMENT 'competition this movement belongs to',
  PRIMARY KEY (`id`,`time`,`action`),
  KEY `action` (`action`,`type`,`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

--
-- Table structure for table `pushsubscription`
--
-- Browser Web Push subscriptions. The daemon sends competition status
-- notifications to these endpoints. Target tuple (compid, targetclass,
-- targetcompno): both target columns '' = whole competition.
--

DROP TABLE IF EXISTS `pushsubscription`;
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

