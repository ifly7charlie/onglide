# Hosted?

If you'd like your competition hosted for you please let me know at melissa-hosting1 [at] onglide.com

## Running (Docker)

This repo includes docker commands to launch everything required to
run your own competition.

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

Optional: a Mapbox access token used by the SoaringSpot scrape to geocode the
contest's free-text location string ("Prievidza, Slovakia") into lat/lng + country
+ timezone. If unset, the scrape skips geocoding and the airfield stays at the
origin (0, 0) until a task is published — at which point the turnpoint coordinates
position it correctly.

```
NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN=pk.your-mapbox-token
```

### Map tiles

Onglide uses MapLibre GL with an OpenMapTiles-schema vector basemap served directly
from a single `.pmtiles` file (no tile server process). Satellite imagery comes from
ESRI World Imagery, and terrain + server-side elevation lookups come from the public
AWS Open Data Terrarium DEM bucket.

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

Once you have configure the environment variables use docker compose to create all the 'services' required.

_NOTE_ You need to re-run build if you change the environment variables as the are copied into the
containers

```
> docker compose build
> docker compose up
```

This will launch the following:

```
* onglide-mysql (db)
* onglide-soaringspot (data synchronisation)
* onglide-ogn (ogn/flarm data feed handler and websocket provider)
* onglide-next (front end next.js)
* onglide-apache (web proxy to route things to the right place)
```

Your website will be available on port 80, and if it is actually reachable at that URL
then an LetsEncrypt SSL certificate should be issued and it will also be available on port 443

You can also link to robocontrol (soaringspot only) to fetch the official flarm ids. The url is the host name you use to login to robocontrol
plus `/api/flarm`

eg:
`https://dunstable.robocontrol.com/api/flarm`

```
ROBOCONTROL_URL=https://dunstable.robocontrol.com/api/flarm
```

#### Running without Apache container

If you do not want to use the Apache container to forward traffic you will need to adjust the docker-compose to expose port `3000` from `next` and port `8080` from `ogn`, and set the .env file `NEXT_PUBLIC_WEBSOCKET_HOST` to point at the `ogn` container port 8080.  The apache container uses rewrite to map these for you.

### RST

### scraping soaringspot (not recommended for hosting competitions but useful for testing)

Instead of configuring client keys configure SOARINGSPOT_URL= to point
ot the en_gb root of the competition URL on soaringspot, eg
https://www.soaringspot.com/en_gb/my-comp-name-2022/

Then use

```
> docker compose -f docker-compose-ssscrape.yml build
> docker compose -f docker-compose-ssscrape.yml up
```

## Installing manually (non-docker)

It isn't difficult to deploy and run this on your own server. However if you would prefer a hosted version please email
your soaring spot keys to melissa-ogn@onglide.com and I can set it up for you.

#### Requirements

-   Mysql server with a database
-   Node and Yarn
-   protoc (https://github.com/protocolbuffers/protobuf/releases or https://github.com/protocolbuffers/protobuf/tree/main/src or `brew install protobuf` `apt install -y protobuf-compiler`)
-   Apache with caching modules (you can deploy the front end somewhere like vercel as well), it also works well behind cloudfront
-   BE AWARE THAT the version of NEXT in the package file IS NOT SAFE WITHOUT A PROXY IN FRONT OF IT * Everything should work on later versions just not on *bsd.

#### Steps

-   create a database and a user with the following rights

```
    > grant insert,update,delete,execute,select on dsample19.\* to reactuser@'xx.xx.xx.xx' identified by 'some-good-password';
```

-   load the database sql & stored procedures

```
    > source conf/sql/onglide_schema.sql;
    > source conf/sql/sp_nextjs.sql
```

-   install yarn packages

```
    > yarn install
```

-   install pm2 (optional)

```
    > yarn global add pm2
```

-   run the onglide installation script (the database must already be loaded)

```
    > yarn setup
```

-   build protobuf and backend

```
    > yarn build
```

-   configure your webserver (there is a sample file but you'll want certificates etc)

-   build the application using yarn

```
    > yarn next build
```

## Running (pm2) - if you can use docker use docker ;)

```
> pm2 start ecosystem.config.js
> pm2 start all
```

-   start webserver

You can use this to see logs

```
> pm2 log
> pm2 log ogn
```

See status

```
> pm2 status
```

Or to monitor processes

```
> pm2 monit
```

pm2 will automatically restart the processes if they fail

## Running (yarn)

-   start the OGN processor (bin/ogn.ts) this will fetch data into the database and send on websocket

```
    > yarn ogn
```

-   start the soaringspot processor

```
    > yarn soaringspot
    or
    > yarn ssscrape
```

`yarn ssscrape` is the scheduler-driven scraper and now handles SGP
sources as well — set up the `scoringsource` row with `type='sgp'` and
the existing SGP API URL and the same daemon picks it up.

-   start the application

```
    > yarn next start
```

-   start webserver

## RST tracking

Instead of using SoaringSpot as the backend it's possible to use RST Online as well.

-   run the normal installation program
-   select RST for scoring system (see steps above) and then ensure the URL provided takes you to the page on RST that lists the competition. Default is "Övriga tävlingar" but it should also work with the HDI Safe Skies pages as well by changing the URL
-   ensure that the contest name matches the prefix of the name, text after the name is assumed to be the contest class

eg: "DM Herrljunga 2021 18-Meter" select "DM Herrljunga 2021" as the contest name, 18-Meter will become the contest class

-   run

## Troubleshooting
