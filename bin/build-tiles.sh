#!/usr/bin/env bash
# Regenerate the Onglide map pmtiles from a fresh planet OSM extract.
#
#   world-streets.<hash>.pmtiles   OpenMapTiles base (no label layers) - street-view mode
#   world-overlay.<hash>.pmtiles   labels + landmarks (conf/pmtiles/landmarks.yml) - drawn
#                                  over satellite imagery and supplying labels everywhere
#
# Each archive is named with a short content hash, so every rebuild produces a
# brand-new URL. That is the only cache-safe way to serve pmtiles through a
# range-caching CDN: replacing a file in place lets the CDN/browser stitch byte
# ranges from the old and new builds together, which decodes as corrupt tiles.
# The resulting URLs are written to ~/pmtiles/pmtiles-manifest.env for the deploy
# to source. Old archives can be deleted once clients have rolled to the new build.
#
# Usage:
#   build-tiles.sh                  # both builds (the monthly refresh)
#   build-tiles.sh streets          # rebuild only world-streets.pmtiles
#   build-tiles.sh overlay          # rebuild only world-overlay.pmtiles
#   build-tiles.sh streets overlay  # both, explicitly
#
# All output goes under ~/pmtiles/ only. The planet PBF is downloaded once and reused
# by both builds. Re-run (no args) monthly against a fresh OSM snapshot.
set -euo pipefail

PMTILES_DIR="$HOME/pmtiles"                                  # the only output root
DATA="$PMTILES_DIR/data"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"      # repo root, from bin/
IMAGE="ghcr.io/onthegomap/planetiler:latest"
PLANET="/data/sources/planet.osm.pbf"                        # path inside the container

# Built archives are published under a content-hashed name; their public URLs
# are written here for the deploy to source into the Next.js build env.
TILE_BASE_URL="${TILE_BASE_URL:-https://tiles.onglide.com}"
MANIFEST="$PMTILES_DIR/pmtiles-manifest.env"

# Which builds to run - all args, or both when none given.
STAGES="${*:-streets overlay}"
want() { [[ " $STAGES " == *" $1 "* ]]; }

# Short content hash of a file - its identity, reused as the filename version tag.
filehash() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -c1-12
    elif command -v sha256 >/dev/null 2>&1; then sha256 -q "$1" | cut -c1-12
    else shasum -a 256 "$1" | cut -c1-12; fi
}

# Record one NEXT_PUBLIC_* line in the manifest, replacing any previous value.
set_manifest() { # key value
    touch "$MANIFEST"
    { grep -v "^$1=" "$MANIFEST" || true; echo "$1=$2"; } > "$MANIFEST.tmp"
    mv "$MANIFEST.tmp" "$MANIFEST"
}

# Move a finished build into place under its content-hashed name and register
# the resulting immutable URL in the manifest.
publish() { # src-path name-stem env-var
    local hash dest
    hash="$(filehash "$1")"
    dest="$2.$hash.pmtiles"
    mv "$1" "$PMTILES_DIR/$dest"
    set_manifest "$3" "$TILE_BASE_URL/$dest"
    echo "Done: $PMTILES_DIR/$dest"
}

mkdir -p "$DATA/sources"
cp "$REPO/conf/pmtiles/landmarks.yml" "$DATA/landmarks.yml"  # keep schema in sync with repo

# The planet node-location cache does not fit in 128GB RAM, so an in-RAM node map
# OOM-crashes. --storage=mmap spills the node + multipolygon caches to memory-mapped
# files on disk (page-cached by the OS), and --nodemap-type=sparsearray keeps that
# cache compact. The read phase needs ~27GB heap for temporary profile storage, so
# -Xmx32g; the rest of RAM is left free for the OS page cache over the mmap files.
planetiler() {
    docker run --rm -e JAVA_TOOL_OPTIONS="-Xmx32g" -v "$DATA":/data "$IMAGE" "$@"
}

# 1. Fetch the planet PBF once (~80GB) into data/sources/; both builds reuse it.
#    Skipped automatically by Planetiler if the cached file is already current.
planetiler --only-download --area=planet --bounds=world \
    --download-threads=10 --download-chunk-size-mb=1000

# 2. Streets - OpenMapTiles base, with poi/housenumber and the five label layers excluded.
#    Planetiler picks the output format from the extension, so the in-progress file must
#    end in .pmtiles; it is built in data/ and only mv'd up to ~/pmtiles/ once complete.
if want streets; then
    planetiler --osm-path="$PLANET" --bounds=world \
        --storage=mmap --nodemap-type=sparsearray \
        --exclude-layers=poi,housenumber,place,transportation_name,aerodrome_label,water_name,mountain_peak \
        --output=/data/world-streets.pmtiles --force
    publish "$DATA/world-streets.pmtiles" world-streets NEXT_PUBLIC_PMTILES_URL
fi

# 3. Overlay - custom schema (labels + landmarks). With --area=planet the schema's
#    osm_url resolves to aws:latest, which a custom schema caches as aws_latest.osm.pbf.
#    Symlink that name to the planet.osm.pbf from step 1 so the same ~80GB download is
#    reused instead of fetched again.
#
#    --minzoom=6: no layer in landmarks.yml has min_zoom below 6, so Planetiler
#    emits no tiles under z6. Without this flag the tileset minzoom defaults to 0,
#    the pmtiles header records 0, and `pmtiles verify` rejects the archive as
#    invalid (header MinZoom=0 != min tile z 6).
if want overlay; then
    ln -sf planet.osm.pbf "$DATA/sources/aws_latest.osm.pbf"
    planetiler generate-custom --schema=/data/landmarks.yml --area=planet \
        --minzoom=6 \
        --storage=mmap --nodemap-type=sparsearray \
        --output=/data/world-overlay.pmtiles --force
    publish "$DATA/world-overlay.pmtiles" world-overlay NEXT_PUBLIC_PMTILES_LABELS_URL
fi

# Surface the URLs the deploy must wire into the Next.js build env. NEXT_PUBLIC_*
# values are inlined when the app is compiled, so the app must be rebuilt for a
# new pmtiles URL to take effect.
echo
echo "pmtiles manifest ($MANIFEST):"
cat "$MANIFEST"
