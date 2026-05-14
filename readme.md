# Tracking

[https://www.onglide.com/]


## Running (Docker)

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

Optional: a separate labels-only pmtiles file. When set, every label/symbol layer
reads from this smaller source instead of the big base pmtiles — so in satellite
mode (where all base fills/lines are hidden by the visibility toggle), MapLibre
stops fetching the big tiles entirely. Typically ~90% bandwidth reduction on
satellite, and the smaller file may fit inside Cloudflare's per-plan cache limit.

```
NEXT_PUBLIC_PMTILES_LABELS_URL=https://tiles.onglide.com/europe-labels.pmtiles
```

If unset, all layers fall back to `NEXT_PUBLIC_PMTILES_URL` (single-source setup).


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

For monthly refreshes, wrap in a shell script with atomic rename so live clients don't
see a partial file:

```
docker run ... --output=/data/europe.pmtiles.new
mv /data/europe.pmtiles.new /srv/tiles/europe.pmtiles
```

Serve the file from any HTTP host that honours byte-range requests (nginx static file
serving with `add_header Accept-Ranges bytes;` works) and point `NEXT_PUBLIC_PMTILES_URL`
at the public URL. Cloudflare in front caches the ranges and handles public egress.

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

You can also use it to specify the soaring spot credentials, or you
can pass then in through your service provider environment variables.

```
SOARINGSPOT_CLIENT_ID=
SOARINGSPOT_SECRET=
```

To enable SSL add ONGLIDE_SSL to the .env file

```
ONGLIDE_SSL=yes
```

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

