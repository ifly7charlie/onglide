# Tracking

[https://www.onglide.com/]

This includes tasks, scoring (AAT/Speed/Distance Handicap) and matching trackers

## Task Types

### AAT

AATs will be scored automatically as pilots fly. You can see what the
solution is by enabling construction lines, and if you also use replay
you can see how it changes as pilots fly the sectors.

### Speed Tasks

Start/Finish times, flown distance speed and landouts all calculated automatically.

### SGP/Regatta starts

If you are running a grand prix and want regattastarts you should
ensure that your task has a start time set and the contest name
includes the text 'SGP' or the task notes has 'grandprix' or 'regatta'. 

Alternatively after the first results are published it will detect
that all the start times are the same and adjust it to be grand prix
scoring.

### Distance Handicap

You can indicate that the task is 'distance handicapped' using an
approximation of the Distance Handicap adjustment programme. This
means that gliders of different handicaps will be scored against
different tasks, when a pilot is selected the map will show
approximately what their task is. (If you know how to exactly
calculate it please let me know)

To enable this add the text 'distance handicapping' or 'distance
handicapped' to the task notes.

It will need to be set every day as the task settings are per set task


## Glider matching and identification

Primary matching is done using the OGN and Flarmnet DDB databases. A
secondary cross check is conducted based on start and finish times
over the course of the competition. This generally corrects incorrect
matches within a few days, as well as picking up unregistered gliders

### Do Not Track 

If a Flarm ID is listed in *either* as 'do not track' they will not be
tracked unless the competition has requested tracking (eg it's in
their rules). OGN does not forward do-not-track packets so in reality
gliders listed as DNT in OGN DDB will not be seen anyway, you need to
change it there

## Delayed Tracking

Onglide can support delayed tracking to mix the IGC delayed trackers
into live Flarm tracking without ghosting. If tracking is delayed it
will be indicated in the status bar.

Normally points are delayed for 10 seconds to allow for out order
packet filtering. This removes 'jumps' from bad trackers

## Landout/Ground tracking

Points on the ground are normally supressed. GPS with poor coverage
may occasionally leak through (jumps) otherwise we miss people running ridges. 

Tracking should stop at 3km from airfield center (marked with a cross on the
map).  Stationary gliders may not be reliably tracked.

## Merging IDs

Onglide can support multiple IDs for a pilot. These are not currently
automatically detected but I'm happy to configure them if needed (it's
used for the delayed IGC trackers and SGP for example)

# Troubleshooting

The map shows a small x mark at the point it has identified as your
airfield. If this mark is in the wrong place it will cause issues with
landouts and failing to identify launched gliders. 

The position is determined by doing a geocode lookup on the airfield
location as you have set in SeeYou/SoaringSpot for the competition.
Don't use abbreviations or add extra details eg Dunstable, UK is ok
but Dunstable LGC, UK will not match and will result in the
competition not tracking.  The name is updated when the competition is
checked so you can change this at any time.



# Other

## Running your own 

This repo includes docker commands to launch everything required to
run your own competition. I don't use docker to run it so the edges will be rough

You should clone the repository, and then configure a file called
**.env** to have at least NEXT_PUBLIC_PMTILES_URL (URL of a self-hosted
OpenMapTiles-schema pmtiles file, see "Map tiles" below), the 'NEXT_PUBLIC_SITEURL'
for the site and a database password (MYSQL_PASSWORD). Without this docker compose
build will fail to build a valid website.

```
MYSQL_PASSWORD=<random string>
NEXT_PUBLIC_PMTILES_URL=<https URL of your .pmtiles file, served with HTTP range support>
NEXT_PUBLIC_SITEURL=<url less protocol, eg localhost:3000 or regionals.onglide.com>
SERVER_ADMIN=<your email address>
```

Optional: override the elevation DEM source (defaults to the free AWS Open Data
Terrarium tiles):

```
NEXT_PUBLIC_DEM_TILE_URL=https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png
```

Optional: cross-competition tracker-identity evidence. `bin/findtrackers.ts`
collects privacy-preserving fingerprints (keyed HMAC hashes of pilot name
tokens and club — never the raw values) from confident matches and reuses them
to recognise the same aircraft in later competitions. Set a long random secret
to enable it; it is the HMAC key, so it **must stay stable and be backed up** —
rotating it orphans all previously stored evidence (the hashes no longer line
up). Leave it unset to disable the feature entirely (the scan still runs). The
tables come from `conf/sql/migrations/20260601_flarm_aircraft.sql`.

```
IDENTITY_HMAC_SECRET=<long random string, kept stable>
```

Optional: a separate labels-only pmtiles file. When set, every label/symbol layer
reads from this smaller source instead of the big base pmtiles — so in satellite
mode (where all base fills/lines are hidden by the visibility toggle), MapLibre
stops fetching the big tiles entirely. Typically ~90% bandwidth reduction on
satellite, and the smaller file may fit inside Cloudflare's per-plan cache limit.

```
NEXT_PUBLIC_PMTILES_LABELS_URL=https://tiles.onglide.com/europe-labels.pmtiles
```

If unset, all layers fall back to `NEXT_PUBLIC_PMTILES_URL` (single-source setup).

Optional: Web Push notifications. Users can subscribe (a bell next to the
competition name) to be notified when a class's status changes — task set,
launching, racing, finishing — even with the browser closed. This needs a VAPID
key pair, generated once with `npx web-push generate-vapid-keys`:

```
NEXT_PUBLIC_VAPID_PUBLIC_KEY=<public key — inlined into the client bundle>
VAPID_PRIVATE_KEY=<private key — daemon only, keep secret>
VAPID_SUBJECT=mailto:<your contact email>
```

If these are unset the feature is silently disabled and the bell does not show.
Push requires the `pushsubscription` table — present in `conf/sql/onglide_schema.sql`,
or apply `conf/sql/migrations/20260522_pushsubscription.sql` to an existing
database. Push needs a secure context (HTTPS or localhost); on iOS the site must
be added to the Home Screen before notifications can be enabled.

Notifications are **opt-in per competition**. The bell appears, and subscriptions
are accepted, only when `competition.pushnotifications = 'Y'` (the column
defaults to `'N'`; apply `conf/sql/migrations/20260522_competition_pushnotifications.sql`
to an existing database). Enable a competition with:

```sql
UPDATE competition SET pushnotifications = 'Y' WHERE compid = 'yourcompid';
```

Clearing it back to `'N'` hides the bell, rejects new subscriptions, and stops
the daemon notifying existing subscribers.


### Map tiles

Onglide uses MapLibre GL with an OpenMapTiles-schema vector basemap served directly
from a single `.pmtiles` file (no tile server process). Satellite imagery comes from
EOX Sentinel-2 cloudless (`tiles.maps.eox.at`) — free for non-commercial use under
CC-BY-NC-SA 4.0 with mandatory attribution; commercial deployments need a paid licence
from [cloudless.eox.at](https://cloudless.eox.at). Terrain + server-side elevation
lookups come from the public AWS Open Data Terrarium DEM bucket.

To generate your own pmtiles blob with [Planetiler](https://github.com/onthegomap/planetiler)
(one-time, regenerate monthly from fresh OSM). The recommended build for Onglide is the
Europe extract with POI and house-number layers dropped (saves ~25% of output size with
no visual impact — neither is rendered by the map style), and languages limited to common
European ones (the single largest size win — OMT bakes in 50+ `name:xx` translations per
feature by default):

```
mkdir -p data
docker run --rm \
  -e JAVA_TOOL_OPTIONS="-Xmx10g" \
  -v "$(pwd)/data":/data \
  ghcr.io/onthegomap/planetiler:latest \
  --download --area=europe \
  --exclude-layers=poi,housenumber \
  --languages=en,de,fr,es,it,pl,cs,nl,sv,fi \
  --output=/data/europe.pmtiles
```

What to expect:

- First run downloads the Europe OSM PBF from Geofabrik (~30 GB) into `./data`, then
  builds the pmtiles. Subsequent runs reuse the cached download.
- Output: `./data/europe.pmtiles`, ~18-20 GB.
- Runtime: ~35-45 min on a machine with 16 GB RAM + SSD.
- Peak disk during build: keep ~150 GB free on the mounted volume (~30 GB input,
  ~80 GB temp, ~20 GB output).

If the build hits memory pressure, drop the heap and switch to mmap storage (trades
RAM for disk, a bit slower):

```
-e JAVA_TOOL_OPTIONS="-Xmx6g" \
...
--storage=mmap
```

Regional variants: swap `--area=europe` for `--area=north-america`, `--area=australia-oceania`,
or `--osm-path=/data/your.osm.pbf` for a custom Geofabrik extract.

For monthly refreshes, do **not** replace the file in place under the same URL.
A range-caching CDN (Cloudflare) caches individual byte ranges; after an in-place
swap it stitches ranges from the old and new build together, which the client
decodes as corrupt tiles. Give every build a unique, immutable URL instead —
`bin/build-tiles.sh` names each archive with a short content hash
(`world-overlay.<hash>.pmtiles`) and writes the new URLs to
`~/pmtiles/pmtiles-manifest.env`. Source that into the deploy, point
`NEXT_PUBLIC_PMTILES_URL` / `NEXT_PUBLIC_PMTILES_LABELS_URL` at the new URLs, and
rebuild the Next.js app (the `NEXT_PUBLIC_*` values are inlined at build time).

Serve the file from any HTTP host that honours byte-range requests (nginx static file
serving with `add_header Accept-Ranges bytes;` works). Because each URL is content-
hashed and never reused, it is served `Cache-Control: immutable` with a one-year
max-age, and the browser cache does the work.

Do **not** put the tiles host behind Cloudflare. pmtiles is read entirely via HTTP
Range requests, and Cloudflare does not cache range responses (a multi-GB archive
also exceeds its cacheable object size) — so it adds no caching benefit, and a
partially-cached object can return byte ranges from different builds, which decodes
as corrupt tiles. Serve `tiles.onglide.com` directly from the range-capable origin.

### Optional: split label layers into a separate pmtiles

For ~90% less tile bandwidth in satellite mode, generate a second, smaller pmtiles
containing only the label source-layers and point `NEXT_PUBLIC_PMTILES_LABELS_URL`
at it. The base build then excludes those label layers so the file isn't duplicated
content:

```
# Base (no labels) — ~15-18 GB for Europe
docker run --rm \
  -e JAVA_TOOL_OPTIONS="-Xmx10g" \
  -v "$(pwd)/data":/data \
  ghcr.io/onthegomap/planetiler:latest \
  --download --area=europe \
  --exclude-layers=poi,housenumber,place,water_name,transportation_name,aerodrome_label,mountain_peak \
  --languages=en,de,fr,es,it,pl,cs,nl,sv,fi \
  --output=/data/europe-base.pmtiles

# Labels only — ~1-2 GB for Europe
docker run --rm \
  -e JAVA_TOOL_OPTIONS="-Xmx10g" \
  -v "$(pwd)/data":/data \
  ghcr.io/onthegomap/planetiler:latest \
  --download --area=europe \
  --exclude-layers=poi,housenumber,water,waterway,landcover,landuse,park,aeroway,building,transportation,boundary \
  --languages=en,de,fr,es,it,pl,cs,nl,sv,fi \
  --output=/data/europe-labels.pmtiles
```

Set both env vars:
```
NEXT_PUBLIC_PMTILES_URL=https://tiles.onglide.com/europe-base.pmtiles
NEXT_PUBLIC_PMTILES_LABELS_URL=https://tiles.onglide.com/europe-labels.pmtiles
```

Same Apache vhost serves both files with no config changes. Regenerate both on the
same OSM snapshot to avoid label-position drift between runs.

### Map fonts (glyphs)

MapLibre renders map labels from pre-generated signed-distance-field glyph atlases —
PBF files, not CSS webfonts. Onglide's map style uses Atkinson Hyperlegible Next (the same UI typeface as the rest
of the app) in three weights: Regular for body labels, Bold for city names, and Italic
for water features — the classic cartographic convention.

Generate the glyphs with `fontnik` from the Atkinson OTF files into `public/fonts/glyphs/`:

```
npm install -g fontnik
build-glyphs AtkinsonHyperlegibleNext-Regular.otf       public/fonts/glyphs/"Atkinson Hyperlegible Next Regular"
build-glyphs AtkinsonHyperlegibleNext-Bold.otf          public/fonts/glyphs/"Atkinson Hyperlegible Next Bold"
build-glyphs AtkinsonHyperlegibleNext-RegularItalic.otf public/fonts/glyphs/"Atkinson Hyperlegible Next Regular Italic"
```

Each weight produces ~256 small `.pbf` files (one per Unicode range), ~2-5 MB total.
Next.js serves them as static assets from `/fonts/glyphs/…`, which matches the default
`NEXT_PUBLIC_GLYPHS_URL=/fonts/glyphs/{fontstack}/{range}.pbf`. Set that env var to a
CDN URL template if you'd rather serve glyphs externally.

The folder name passed to `build-glyphs` becomes the fontstack string MapLibre references
in `text-font`; it must exactly match the names in the `FONT_REGULAR`, `FONT_BOLD`, and
`FONT_ITALIC` constants at the top of `lib/react/mapStyle.ts`.

Atkinson Hyperlegible Next OTFs are a free download from Braille Institute, or from
the [Google Fonts repo](https://github.com/googlefonts/atkinson-hyperlegible-next).
The `.woff2` files in `public/fonts/` are for the UI (CSS only) and not usable here.

SoaringSpot OAuth API credentials no longer come from `.env` — they live
in the `scoringsource` table per competition. Insert one row of
`type = 'soaringspotkey'` with `client_id`, `secret` and the local
`compid`, and the scoring scraper (`yarn ssscrape`) picks it up on the
next heartbeat. Optional columns:
  - `contest_name` to disambiguate when the key has access to multiple contests
  - `actuals`: `1` (FAI/IGC actuals — default), `0` (handicapped speeds), `-1` (BGA decimal-encoded)

To enable SSL add ONGLIDE_SSL to the .env file

```
ONGLIDE_SSL=yes
```

### Built-in Let's Encrypt certificates (standalone deployments)

When the OGN daemon serves TLS itself (from `keys/<host>.key.pem` +
`keys/<host>.cert.pem` on `WEBSOCKET_PORT + 1000`), it can also obtain and
renew that certificate automatically via ACME. Renewed certificates are
hot-swapped into the running listener — no restart, connected clients are
untouched. With no certificate on disk yet, the daemon orders one at startup
and brings the TLS listener up as soon as it is issued.

This is for standalone (non-docker) deployments only: the docker topologies
already terminate TLS in Traefik or Apache mod_md with their own ACME — leave
`ACME_ENABLED` unset there.

```
ACME_ENABLED=1                     # opt-in; only NEXT_PUBLIC_WEBSOCKET_HOST is managed
ACME_EMAIL=you@example.com         # account contact; falls back to SERVER_ADMIN
ACME_STAGING=1                     # use the Let's Encrypt staging CA while testing
#ACME_DIRECTORY=https://...        # full directory URL override (wins over ACME_STAGING)
#ACME_RENEW_DAYS=30                # renew when fewer than this many days remain
#ACME_PORT80=0                     # skip the temporary :80 challenge listener
```

Setting `ACME_ENABLED` implies agreement to the CA's Terms of Service
(`termsOfServiceAgreed` in the ACME account registration). The account key is
created on first use at `keys/acme/account.key.pem` — staging and production
accounts are separate, so delete it when switching `ACME_STAGING` off.

The certificate itself is reissued automatically on that switch: the directory
that issued it is recorded in `keys/<host>.directory`, and a certificate from
any other directory (or one from a staging CA when the configured directory is
not staging) counts as due however much validity is left on it. So changing
`ACME_STAGING` or `ACME_DIRECTORY` takes effect at the next check — `kill -USR2
<pid>` for it to happen now — rather than when the old certificate expires.

Validation is http-01, so port 80 of the websocket host must reach this
daemon: either leave `ACME_PORT80` at its default so the daemon binds :80
itself for the seconds the challenge lasts (needs the privilege to do so), or
forward `/.well-known/acme-challenge/` from whatever owns port 80 to the
daemon's `WEBSOCKET_PORT`. If neither is in place the renewal fails loudly and
retries with backoff — the daemon itself keeps running. Keep the clock
NTP-synced; certificate lifetimes and ACME signatures both depend on it.

Renewal is checked twice a day and `ACME_RENEW_DAYS` before expiry. To force a
check immediately (e.g. after fixing a forward): `kill -USR2 <pid>`. Current
state — days remaining, last error, next check — is in the `acme` object of
`/status/overview`. External certificate-expiry monitoring is still a good
idea; the daemon can only complain to its own log.

### Per-competition official tracking delay

Each row in the `competition` table has a `delayseconds` column controlling how
far behind real-time the public stream lags for that comp's scoring worker
(propagated to the frontend label in the time strip and pilot panel). `NULL`
means inherit from the `NEXT_PUBLIC_COMPETITION_DELAY` env var (default 10s);
set a numeric value to override per-comp. Live edits picked up on the next
60s reconcile tick — no daemon restart required.

```
UPDATE competition SET delayseconds = 600 WHERE compid = 'mychamps2026';
UPDATE competition SET delayseconds = NULL WHERE compid = 'leagueround3'; -- back to env-var default
```

### Per-glider scoring logs

The scoring worker writes a diagnostic log per glider for the lifetime of its
current scoring chain to `<datecode>/<class>/<compno>.log` — the file is
truncated whenever the glider is rescored. Writes are batched in memory and
flushed every few seconds, so they don't sit on the scoring hot path.

By default these go under `logs/` in the process working directory. Override
the base directory with `SCORING_LOG_DIR` (absolute, or relative to the cwd):

```
SCORING_LOG_DIR=/var/log/onglide
```

