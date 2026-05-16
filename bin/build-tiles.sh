#!/usr/bin/env bash
# Regenerate the Onglide map pmtiles from a fresh planet OSM extract.
#
#   world-streets.pmtiles   OpenMapTiles base (no label layers) - street-view mode
#   world-overlay.pmtiles   labels + landmarks (conf/pmtiles/landmarks.yml) - drawn
#                           over satellite imagery and supplying labels everywhere
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

# Which builds to run - all args, or both when none given.
STAGES="${*:-streets overlay}"
want() { [[ " $STAGES " == *" $1 "* ]]; }

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
    mv "$DATA/world-streets.pmtiles" "$PMTILES_DIR/world-streets.pmtiles"
    echo "Done: $PMTILES_DIR/world-streets.pmtiles"
fi

# 3. Overlay - custom schema (labels + landmarks). With --area=planet the schema's
#    osm_url resolves to aws:latest, which a custom schema caches as aws_latest.osm.pbf.
#    Symlink that name to the planet.osm.pbf from step 1 so the same ~80GB download is
#    reused instead of fetched again.
if want overlay; then
    ln -sf planet.osm.pbf "$DATA/sources/aws_latest.osm.pbf"
    planetiler generate-custom --schema=/data/landmarks.yml --area=planet \
        --storage=mmap --nodemap-type=sparsearray \
        --output=/data/world-overlay.pmtiles --force
    mv "$DATA/world-overlay.pmtiles" "$PMTILES_DIR/world-overlay.pmtiles"
    echo "Done: $PMTILES_DIR/world-overlay.pmtiles"
fi
