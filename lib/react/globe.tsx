import {useMemo, useState, useCallback, useEffect, useRef} from 'react';
import Router from 'next/router';

import {DeckGL} from '@deck.gl/react';
import {_GlobeView as GlobeView, COORDINATE_SYSTEM, LightingEffect, AmbientLight, _SunLight as SunLight, FlyToInterpolator} from '@deck.gl/core';
import {GeoJsonLayer, IconLayer, ScatterplotLayer, TextLayer} from '@deck.gl/layers';
import {SimpleMeshLayer} from '@deck.gl/mesh-layers';
import {SphereGeometry} from '@luma.gl/engine';
import {faEye} from '@fortawesome/free-solid-svg-icons';
import {FontAwesomeIcon} from '@fortawesome/react-fontawesome';

import {useTranslation} from 'next-i18next/pages';

import {faClockRotateLeft, faHourglassStart, faTrophy} from '@fortawesome/free-solid-svg-icons';

import type {TaskDetails, ClassWinner} from '../protobuf/onglide';
import type {Epoch} from '../types';
import {OptionalDurationMM} from './optional';
import {STATUS_COLOURS, STATUS_LABEL_KEYS, StatusIcon, statusCss, statusIconDataUrl, type CompetitionDisplayStatus} from './competition-status';
import {useStatusSummary, type StatusSummary} from './statusSummary';
import {LanguageSwitcher} from './language-switcher';
import {TranslationHelpFooter} from './translation-help-footer';

// Earth radius in metres — matches the radius deck.gl's GlobeView uses
// internally for its projection math, so a sphere mesh of this size lines
// up exactly with marker/label positions placed via lat/lng.
const EARTH_RADIUS_METERS = 6.3e6;

// Pre-built white-on-transparent SVG data URLs for each status icon, used by
// the deck.gl IconLayer that overlays icons on the marker dots. Built once
// at module load — the URLs are stable strings so deck.gl's image cache hits
// on every frame.
const STATUS_ICON_URLS: Record<CompetitionDisplayStatus, string> = (Object.keys(STATUS_COLOURS) as CompetitionDisplayStatus[]).reduce(
    (acc, s) => {
        acc[s] = statusIconDataUrl(s, 'white');
        return acc;
    },
    {} as Record<CompetitionDisplayStatus, string>
);

export interface CompetitionClass {
    class: string;
    classname: string;
    status: string;
    pilotCount: number;
    displayStatus: CompetitionDisplayStatus;
    taskDetails?: TaskDetails;
    winner?: ClassWinner;
    nostartutc?: number;
}

export interface Competition {
    compid: string;
    name: string;
    sitename: string | null;
    lat: number;
    lng: number;
    start: string;
    end: string;
    countrycode: string;
    tz: string;
    tzoffset: number;
    mainwebsite: string | null;
    urllogo: string | null;
    classCount: number;
    officialDelay?: number;
    classes?: CompetitionClass[];
    classStatusesDiffer?: boolean;
    displayStatus: CompetitionDisplayStatus;
}

// Rank for ordering Live comps: most-active status first, then by current
// viewer count, then by registered pilot count. Marker draw order is the
// reverse of this so the top-of-list comp is rendered last (= on top), which
// is what deck.gl picking returns when dots are stacked at one location.
const STATUS_RANK: Record<CompetitionDisplayStatus, number> = {
    finishing: 0,
    started: 1,
    launching: 2,
    task_set: 3,
    home: 4,
    notask: 5,
    cancelled: 6,
    yesterday: 7,
    upcoming: 8
};

function compPilotCount(c: Competition): number {
    return (c.classes ?? []).reduce((s, cls) => s + (cls.pilotCount || 0), 0);
}

function compRank(c: Competition): number {
    const classes = c.classes ?? [];
    if (!classes.length) return STATUS_RANK[c.displayStatus] ?? 99;
    return Math.min(...classes.map((cls) => STATUS_RANK[cls.displayStatus] ?? 99));
}

function splitAndSortByRank(comps: Competition[], summary: StatusSummary | null): {live: Competition[]; upcoming: Competition[]} {
    const live = comps
        .filter((c) => c.displayStatus !== 'upcoming')
        .sort((a, b) => {
            const ra = compRank(a);
            const rb = compRank(b);
            if (ra !== rb) return ra - rb;
            const va = summary?.byComp.get(a.compid)?.viewers ?? 0;
            const vb = summary?.byComp.get(b.compid)?.viewers ?? 0;
            if (va !== vb) return vb - va;
            return compPilotCount(b) - compPilotCount(a);
        });
    const upcoming = comps.filter((c) => c.displayStatus === 'upcoming');
    return {live, upcoming};
}

//
// Pick an initial view state for the globe: centered on the centroid of all
// visible competitions. If competitions cluster tightly, zoom in; otherwise
// leave it as a global view so the user sees the whole map.
//
function computeInitialViewState(comps: Competition[]) {
    if (!comps.length) {
        return {latitude: 20, longitude: 0, zoom: 0};
    }
    const lats = comps.map((c) => c.lat).filter((v) => typeof v === 'number');
    const lngs = comps.map((c) => c.lng).filter((v) => typeof v === 'number');
    const latMean = lats.reduce((a, b) => a + b, 0) / Math.max(lats.length, 1);
    const lngMean = lngs.reduce((a, b) => a + b, 0) / Math.max(lngs.length, 1);
    const latRange = lats.length ? Math.max(...lats) - Math.min(...lats) : 0;
    const lngRange = lngs.length ? Math.max(...lngs) - Math.min(...lngs) : 0;
    const span = Math.max(latRange, lngRange);
    // Rough zoom heuristic: tighter cluster -> closer zoom
    const zoom = span < 5 ? 4.5 : span < 15 ? 3.5 : span < 40 ? 2.5 : 1.5;
    return {latitude: latMean, longitude: lngMean, zoom};
}

//
// Globe visualisation of all competitions, with a right-side list panel.
//
// Hover coordination between the list and the globe is routed through a
// single `highlightedCompid` state:
//   - hovering a marker on the globe sets the state, which highlights the
//     matching list entry (background tint).
//   - hovering a list entry sets the state AND flies the globe to the
//     competition's coordinates with a smooth FlyToInterpolator animation.
// Because the state is shared, marker and list are always visually in sync.
//
export function CompetitionGlobe({competitions, countriesGeoJson}: {competitions: Competition[]; countriesGeoJson: any}) {
    const {t} = useTranslation('common');
    const [highlightedCompid, setHighlightedCompid] = useState<string | null>(null);
    const summary = useStatusSummary();

    // "In view only" filter for the list. Doesn't affect the markers — markers
    // off-screen are already invisible on the globe, so filtering the markers
    // would be redundant work.
    const [filterToView, setFilterToView] = useState(false);

    // Canvas size, tracked via a ResizeObserver on the container so it's
    // populated on mount (DeckGL's own onResize only fires after the first
    // re-render — toggling the in-view filter pre-interaction would otherwise
    // do nothing because width/height were still 0). Used together with the
    // live viewState to construct a Viewport for the in-view projection test.
    const canvasRef = useRef<HTMLDivElement | null>(null);
    const [canvasSize, setCanvasSize] = useState<{width: number; height: number}>({width: 0, height: 0});
    useEffect(() => {
        const el = canvasRef.current;
        if (!el) return;
        const update = () => {
            const r = el.getBoundingClientRect();
            setCanvasSize((prev) => (prev.width === r.width && prev.height === r.height ? prev : {width: r.width, height: r.height}));
        };
        update();
        const ro = new ResizeObserver(update);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    // Refs to each list entry, keyed by compid, so hovering/clicking a marker
    // on the globe can scroll the corresponding row into view in the side panel.
    const entryRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
    const scrollEntryIntoView = useCallback((compid: string) => {
        entryRefs.current.get(compid)?.scrollIntoView({behavior: 'smooth', block: 'nearest'});
    }, []);

    // Click on a marker reveals the row immediately.
    const revealCompid = useCallback(
        (compid: string) => {
            setHighlightedCompid(compid);
            scrollEntryIntoView(compid);
        },
        [scrollEntryIntoView]
    );

    // Hover scroll is debounced so brushing the cursor across markers doesn't
    // chase the side panel through the whole list. The latest hover wins; a
    // hover-out cancels the pending scroll.
    const hoverScrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const scheduleHoverScroll = useCallback(
        (compid: string | null) => {
            if (hoverScrollTimer.current) clearTimeout(hoverScrollTimer.current);
            if (!compid) return;
            hoverScrollTimer.current = setTimeout(() => scrollEntryIntoView(compid), 250);
        },
        [scrollEntryIntoView]
    );
    useEffect(() => () => {
        if (hoverScrollTimer.current) clearTimeout(hoverScrollTimer.current);
    }, []);

    // Drop competitions with missing coordinates before feeding them to any
    // layer — a null lat/lng will silently cause TextLayer to drop the whole
    // layer, and also skews the centroid used for the initial view.
    const visibleCompetitions = useMemo(
        () => competitions.filter((c) => typeof c.lat === 'number' && typeof c.lng === 'number' && Number.isFinite(c.lat) && Number.isFinite(c.lng) && !(c.lat === 0 && c.lng === 0)),
        [competitions]
    );

    const initialViewState = useMemo(() => computeInitialViewState(visibleCompetitions), [visibleCompetitions]);

    // Controlled view state so we can programmatically fly to a competition
    // when the user hovers a list entry. onViewStateChange feeds user drag/
    // zoom back into the same state.
    const [viewState, setViewState] = useState<any>(initialViewState);

    // Reset the view when the competitions list first arrives. We only
    // want this on the empty -> populated transition (so subsequent SWR
    // refreshes don't yank a user who's panned away); useEffect with
    // `hasData` as the sole dep fires exactly once per transition.
    const hasData = competitions.length > 0;
    useEffect(() => {
        if (hasData) {
            setViewState((prev: any) => ({...prev, ...initialViewState}));
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [hasData]);

    // While the /all websocket hasn't yet delivered the snapshot, slowly
    // rotate the globe so the page reads as loading rather than broken.
    useEffect(() => {
        if (hasData) return;
        let raf = 0;
        let last = performance.now();
        const tick = (now: number) => {
            const dt = now - last;
            last = now;
            setViewState((prev: any) => ({
                ...prev,
                longitude: ((prev.longitude ?? 0) + dt * 0.015 + 540) % 360 - 180,
                transitionDuration: 0,
                transitionInterpolator: undefined
            }));
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [hasData]);

    // Fly to a competition's coordinates on list hover. Wrapped in
    // useCallback so the list panel's hover handlers don't re-render the
    // whole component each time.
    //
    // Skip while the "in view only" filter is on: moving the camera would
    // mutate the in-view set, reorder/shrink the list under the cursor, and
    // trigger a new hover on whichever entry slid into place — producing a
    // runaway feedback loop. Filtered users navigate by zooming the globe.
    const flyTo = useCallback(
        (comp: Competition) => {
            if (filterToView) return;
            if (typeof comp.lat !== 'number' || typeof comp.lng !== 'number') return;
            setViewState((prev: any) => ({
                ...prev,
                longitude: comp.lng,
                latitude: comp.lat,
                zoom: Math.max(prev.zoom ?? 1, 3.5),
                transitionDuration: 1000,
                transitionInterpolator: new FlyToInterpolator({speed: 1.2})
            }));
        },
        [filterToView]
    );

    // One stable GlobeView instance, used both as the DeckGL `views` prop and
    // to build a Viewport for the "in view only" projection test.
    const globeView = useMemo(() => new GlobeView({id: 'globe', resolution: 10}), []);

    // Set of compids currently inside the viewport (with a small margin), or
    // null when the filter is off. Recomputed on every pan/zoom but only when
    // the filter is on, so unrelated view changes stay cheap.
    const inViewCompids = useMemo<Set<string> | null>(() => {
        if (!filterToView || canvasSize.width === 0 || canvasSize.height === 0) return null;
        let viewport: any;
        try {
            viewport = (globeView as any).makeViewport({width: canvasSize.width, height: canvasSize.height, viewState});
        } catch {
            return null;
        }
        // Guard against points on the back of the sphere: project() still
        // returns finite pixel coords for the antipode on a GlobeView. The
        // great-circle distance from the camera centre gives a definitive
        // back/front test — cosD < ~0 means more than 90° away.
        const camLatRad = ((viewState.latitude ?? 0) * Math.PI) / 180;
        const camLngRad = ((viewState.longitude ?? 0) * Math.PI) / 180;
        const sinCamLat = Math.sin(camLatRad);
        const cosCamLat = Math.cos(camLatRad);
        const ids = new Set<string>();
        for (const c of visibleCompetitions) {
            const pLatRad = (c.lat * Math.PI) / 180;
            const pLngRad = (c.lng * Math.PI) / 180;
            const cosD = sinCamLat * Math.sin(pLatRad) + cosCamLat * Math.cos(pLatRad) * Math.cos(pLngRad - camLngRad);
            if (cosD < 0.05) continue;
            const projected = viewport.project([c.lng, c.lat]);
            if (!projected) continue;
            const [x, y] = projected;
            if (x >= 0 && x <= canvasSize.width && y >= 0 && y <= canvasSize.height) {
                ids.add(c.compid);
            }
        }
        return ids;
    }, [filterToView, globeView, canvasSize.width, canvasSize.height, viewState, visibleCompetitions]);

    // Sort once for both purposes: the side panel reads `panelLists` (filtered
    // by `inViewCompids` when the tickbox is on), and the marker layers read
    // `markerData` (always all comps, ordered so the top-of-list comp is the
    // last instance drawn → picked first when dots overlap).
    const sortedAll = useMemo(() => splitAndSortByRank(visibleCompetitions, summary), [visibleCompetitions, summary]);
    const panelLists = useMemo(() => {
        if (!inViewCompids) return sortedAll;
        return {
            live: sortedAll.live.filter((c) => inViewCompids.has(c.compid)),
            upcoming: sortedAll.upcoming.filter((c) => inViewCompids.has(c.compid))
        };
    }, [sortedAll, inViewCompids]);
    const markerData = useMemo(() => [...[...sortedAll.upcoming].reverse(), ...[...sortedAll.live].reverse()], [sortedAll]);

    const layers = useMemo(() => {
        // Densely-tessellated sphere mesh for the ocean. See earlier commit
        // for why SimpleMeshLayer+SphereGeometry replaced TileLayer: the
        // pre-tessellated mesh has no seams, and there's no raster fetch.
        const earthSphere = new SimpleMeshLayer({
            id: 'earth-sphere',
            data: [0],
            // @ts-ignore SphereGeometry type shim
            mesh: new SphereGeometry({radius: EARTH_RADIUS_METERS, nlat: 36, nlong: 72}),
            coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
            getPosition: () => [0, 0, 0],
            getColor: [20, 50, 90, 255],
            material: {ambient: 0.5, diffuse: 0.6, shininess: 32, specularColor: [30, 30, 30]}
        });

        // Land polygons rendered over the sphere. Natural Earth 1:50m land,
        // served locally from /public. Public domain.
        const countries = new GeoJsonLayer({
            id: 'earth-land',
            data: countriesGeoJson || '/ne_50m_land.geojson',
            stroked: false,
            filled: true,
            opacity: 0.6,
            getFillColor: [60, 110, 70, 255],
            material: {ambient: 0.4, diffuse: 0.6, shininess: 32, specularColor: [60, 60, 60]}
        });

        // Competition markers. getRadius + getLineWidth vary per-competition
        // so the highlighted one (matching highlightedCompid) renders larger
        // and with a heavier outline. updateTriggers wire them to
        // highlightedCompid so deck.gl re-uploads the buffers on change.
        const markers = new ScatterplotLayer<Competition>({
            id: 'competition-markers',
            data: markerData,
            pickable: true,
            getPosition: (c) => [c.lng, c.lat, 0],
            getFillColor: (c) => STATUS_COLOURS[c.displayStatus],
            getLineColor: (c) => (c.compid === highlightedCompid ? [255, 255, 255, 255] : [0, 0, 0, 220]),
            getRadius: (c) => (c.compid === highlightedCompid ? 14 : 8),
            radiusUnits: 'pixels',
            lineWidthUnits: 'pixels',
            stroked: true,
            lineWidthMinPixels: 1,
            getLineWidth: (c) => (c.compid === highlightedCompid ? 3 : 1),
            onClick: (info) => {
                const comp = info.object as Competition | undefined;
                if (comp) revealCompid(comp.compid);
            },
            onHover: (info) => {
                const compid = ((info.object as Competition) ?? null)?.compid ?? null;
                setHighlightedCompid(compid);
                scheduleHoverScroll(compid);
            },
            updateTriggers: {
                getFillColor: [markerData],
                getLineColor: [highlightedCompid],
                getRadius: [highlightedCompid],
                getLineWidth: [highlightedCompid]
            }
        });

        // White-on-coloured-dot status icon centered on each marker. Drawn
        // separately from the ScatterplotLayer so the dot keeps its solid
        // colour fill and the icon sits cleanly on top.
        const markerIcons = new IconLayer<Competition>({
            id: 'competition-marker-icons',
            data: markerData,
            pickable: false,
            getPosition: (c) => [c.lng, c.lat, 0],
            getIcon: (c) => ({
                url: STATUS_ICON_URLS[c.displayStatus],
                width: 64,
                height: 64,
                anchorX: 32,
                anchorY: 32,
                mask: false
            }),
            getSize: (c) => (c.compid === highlightedCompid ? 18 : 11),
            sizeUnits: 'pixels',
            updateTriggers: {
                getIcon: [markerData],
                getSize: [highlightedCompid]
            }
        });

        // SDF font is required whenever outlineWidth > 0; characterSet: 'auto'
        // handles non-ASCII glyphs in competition names.
        const labels = new TextLayer<Competition>({
            id: 'competition-labels',
            data: markerData,
            characterSet: 'auto',
            fontSettings: {sdf: true},
            getPosition: (c) => [c.lng, c.lat, 0],
            getText: (c) => c.name,
            getSize: 12,
            getColor: [255, 255, 255, 240],
            getPixelOffset: [0, 20],
            outlineWidth: 2,
            outlineColor: [0, 0, 0, 220],
            fontWeight: 600,
            getTextAnchor: 'middle',
            getAlignmentBaseline: 'top'
        });

        return [earthSphere, countries, markers, markerIcons, labels].filter(Boolean) as any[];
    }, [markerData, countriesGeoJson, highlightedCompid]);

    // Lighting with SunLight at current time. Recomputed once on mount.
    const effects = useMemo(
        () => [
            new LightingEffect({
                ambient: new AmbientLight({color: [255, 255, 255], intensity: 0.5}),
                sun: new SunLight({color: [255, 255, 255], intensity: 2.0, timestamp: Date.now()})
            })
        ],
        []
    );

    return (
        <div style={{position: 'fixed', inset: 0, background: '#0b1a33'}}>
            <div className="globe-canvas" ref={canvasRef}>
                <DeckGL
                    views={globeView as any}
                    viewState={viewState as any}
                    onViewStateChange={({viewState: v}: any) => setViewState(v)}
                    controller={hasData}
                    effects={effects as any}
                    parameters={{cull: true} as any}
                    layers={layers}
                />
            </div>

            {!hasData ? (
                <div
                    style={{
                        position: 'absolute',
                        left: 0,
                        right: 0,
                        bottom: '12vh',
                        textAlign: 'center',
                        color: 'rgba(255,255,255,0.85)',
                        fontSize: 16,
                        letterSpacing: '0.02em',
                        pointerEvents: 'none',
                        textShadow: '0 1px 2px rgba(0,0,0,0.6)'
                    }}
                >
                    {t('app.loading_competitions')}
                </div>
            ) : null}

            {/* Right-side competition list panel */}
            <CompetitionListPanel
                live={panelLists.live}
                upcoming={panelLists.upcoming}
                summary={summary}
                hasAnyComps={competitions.length > 0}
                highlightedCompid={highlightedCompid}
                setHighlightedCompid={setHighlightedCompid}
                flyTo={flyTo}
                entryRefs={entryRefs}
            />

            {hasData ? (
                <label className="map-filter-toggle">
                    <input type="checkbox" checked={filterToView} onChange={(e) => setFilterToView(e.target.checked)} />
                    {t('competition.in_view_only')}
                </label>
            ) : null}

            <div className="map-legend">
                {(['upcoming', 'notask', 'task_set', 'launching', 'started', 'finishing', 'home', 'yesterday'] as const).map((s) => (
                    <div key={s} className="legend-row">
                        <span className="status-dot" style={{background: statusCss(s)}}>
                            <StatusIcon status={s} />
                        </span>
                        {t(STATUS_LABEL_KEYS[s])}
                    </div>
                ))}
            </div>

            <div className="map-attribution">
                {t('competition.land_data')}{' '}
                <a href="https://www.naturalearthdata.com/" target="_blank" rel="noopener noreferrer">
                    {t('competition.natural_earth')}
                </a>
            </div>
        </div>
    );
}

//
// Right-side list of competitions. Hovering a row flies the globe to that
// competition and marks it as the highlighted entry; the matching marker
// on the globe gets the ring treatment via ScatterplotLayer's updateTriggers.
//
function CompetitionListPanel({
    live,
    upcoming,
    summary,
    hasAnyComps,
    highlightedCompid,
    setHighlightedCompid,
    flyTo,
    entryRefs
}: {
    live: Competition[];
    upcoming: Competition[];
    summary: StatusSummary | null;
    hasAnyComps: boolean;
    highlightedCompid: string | null;
    setHighlightedCompid: (id: string | null) => void;
    flyTo: (c: Competition) => void;
    entryRefs: React.MutableRefObject<Map<string, HTMLDivElement | null>>;
}) {
    // All hooks must run on every render — call them before any early return,
    // otherwise the hook order changes between renders and React errors out.
    const {t} = useTranslation('common');
    if (!hasAnyComps) return null;

    const renderSection = (titleKey: 'live' | 'upcoming', comps: Competition[], clickable: boolean, suffix?: React.ReactNode) => {
        if (!comps.length) return null;
        const headerKey = titleKey === 'live' ? 'competition.live_count' : 'competition.upcoming_count';
        return (
            <>
                <div className="sidepanel-section-header">
                    {t(headerKey, {count: comps.length})}
                    {suffix}
                </div>
                {comps.map((c) => (
                    <CompetitionListEntry
                        key={c.compid}
                        comp={c}
                        summary={summary}
                        highlighted={c.compid === highlightedCompid}
                        clickable={clickable}
                        registerRef={(el) => {
                            if (el) entryRefs.current.set(c.compid, el);
                            else entryRefs.current.delete(c.compid);
                        }}
                        onHover={() => {
                            setHighlightedCompid(c.compid);
                            flyTo(c);
                        }}
                        onLeave={() => setHighlightedCompid(null)}
                        onClick={() => {
                            if (clickable) Router.push('/' + c.compid + '/');
                        }}
                    />
                ))}
            </>
        );
    };

    const liveRegistered = live.reduce((sum, c) => sum + (c.classes ?? []).reduce((s, cls) => s + (cls.pilotCount || 0), 0), 0);

    const liveSuffix = summary && summary.totals.pilots > 0 ? (
        <span className="sidepanel-section-stats">
            {t('competition.live_stats', {tracked: summary.totals.pilots, registered: liveRegistered, flying: summary.totals.flying, landed: summary.totals.landed})}
            {' · '}<FontAwesomeIcon icon={faEye} /> {summary.totals.viewers}
        </span>
    ) : null;

    return (
        <aside className="sidepanel sidepanel-globe">
            <div className="sidepanel-brand sidepanel-brand-row">
                <span className="sidepanel-brand-text">{t('app.title')}</span>
                <LanguageSwitcher className="sidepanel-brand-lang" />
            </div>
            <div className="sidepanel-body">
                {renderSection('live', live, true, liveSuffix)}
                {renderSection('upcoming', upcoming, false)}
            </div>
            <div className="sidepanel-footer">
                <TranslationHelpFooter />
            </div>
        </aside>
    );
}

//
// A single row in the list. Styling is copied from the previous bottom-left
// hover tooltip: name big, sitename/dates smaller, status dot + label below.
// If the competition's classes have different displayStatuses, each class
// gets its own dot + label; otherwise a single rollup dot is shown.
//
function CompetitionListEntry({
    comp,
    summary,
    highlighted,
    clickable,
    registerRef,
    onHover,
    onLeave,
    onClick
}: {
    comp: Competition;
    summary: StatusSummary | null;
    highlighted: boolean;
    clickable: boolean;
    registerRef: (el: HTMLDivElement | null) => void;
    onHover: () => void;
    onLeave: () => void;
    onClick: () => void;
}) {
    const {t} = useTranslation('common');
    const classes = comp.classes ?? [];

    // Competitions in their active window get a per-class breakdown with
    // status dot + class name + task length/time (or winner once flown) on
    // each line. Upcoming shows a compact rollup — "N classes · M pilots".
    const inActiveWindow = comp.displayStatus !== 'upcoming';
    const totalPilots = classes.reduce((sum, cls) => sum + (cls.pilotCount || 0), 0);
    const compTracked = summary?.byComp.get(comp.compid)?.tracked;

    const entryClass = ['sidepanel-entry', highlighted ? 'highlighted' : '', !clickable ? 'non-clickable' : ''].filter(Boolean).join(' ');

    // "tracked/total pilots" when we have a live count for this comp/class;
    // otherwise just "total pilots".
    const formatPilotCount = (total: number, tracked: number | undefined) => {
        if (typeof tracked === 'number') return t('competition.tracked_pilots', {tracked, total});
        return t('competition.pilot', {count: total});
    };

    // Right-hand metric for a class row: trophy + winner once a day has been
    // flown (home/yesterday), otherwise task length (speed) or task time
    // (AAT). Returns null when there's nothing meaningful to show — pre-task
    // and upcoming classes render with just the status pill and class name.
    const renderClassMetric = (cls: CompetitionClass) => {
        if ((cls.displayStatus === 'home' || cls.displayStatus === 'yesterday') && cls.winner) {
            const w = cls.winner;
            const value =
                typeof w.taskSpeed === 'number' && w.taskSpeed > 0
                    ? `${w.taskSpeed.toFixed(1)} km/h`
                    : typeof w.taskDistance === 'number' && w.taskDistance > 0
                      ? `${w.taskDistance.toFixed(1)} km`
                      : null;
            if (!value) return null;
            return (
                <span className="count">
                    <FontAwesomeIcon icon={faTrophy} /> {w.compno} {value}
                </span>
            );
        }
        const td = cls.taskDetails;
        if (td) {
            // Append the start-open time when nostartutc is set and still in
            // the future — i.e. the gate hasn't opened yet for this class.
            // td.nostart is the local HH:MM:SS string from the DB row; trim
            // to HH:MM for display.
            // Viewer clock is real-time minus the comp's officialDelay; the
            // gate "appears" closed to the viewer until nostartutc + delay.
            const viewerNowSec = Date.now() / 1000 - (comp.officialDelay ?? 0);
            const startNotOpen = (cls.nostartutc ?? 0) > viewerNowSec;
            const openTime = startNotOpen && td.nostart && td.nostart !== '00:00:00' ? td.nostart.slice(0, 5) : null;
            const delayed = (comp.officialDelay ?? 0) > 10;
            const openSuffix = openTime ? (
                <>
                    {' · '}
                    <FontAwesomeIcon icon={faHourglassStart} /> {openTime}
                    {delayed ? (
                        <span title={t('pilot.view_delayed_official')}>
                            {' '}
                            <FontAwesomeIcon icon={faClockRotateLeft} /> {OptionalDurationMM('', (comp.officialDelay ?? 0) as Epoch, 'm')}
                        </span>
                    ) : null}
                </>
            ) : null;
            if (td.type === 'A' && td.duration) {
                return (
                    <span className="count">
                        {td.duration.replace(/^0?(\d+):(\d\d):\d\d$/, '$1:$2')} AAT{openSuffix}
                    </span>
                );
            }
            if (td.distance > 0) {
                return (
                    <span className="count">
                        {td.distance.toFixed(1)} km{openSuffix}
                    </span>
                );
            }
        }
        return null;
    };

    return (
        <div ref={registerRef} onMouseEnter={onHover} onMouseLeave={onLeave} onClick={onClick} className={entryClass}>
            <div className="entry-row">
                {comp.urllogo ? (
                    <div className="entry-logo">
                        <img src={comp.urllogo} alt="" />
                    </div>
                ) : null}
                <div className="entry-text">
                    <div className="entry-title">{comp.name}</div>
                    {comp.sitename ? <div className="entry-sitename">{comp.sitename}</div> : null}
                    <div className="entry-dates">
                        {comp.start} – {comp.end}
                    </div>
                </div>
            </div>
            {inActiveWindow && classes.length > 0
                ? classes.map((cls) => {
                      return (
                          <div
                              key={cls.class}
                              className="entry-classrow"
                              onClick={(e) => {
                                  e.stopPropagation();
                                  Router.push('/' + comp.compid + '?className=' + cls.class);
                              }}
                          >
                              <span className="status-pill" style={{background: statusCss(cls.displayStatus)}}>
                                  <StatusIcon status={cls.displayStatus} />
                                  {t(STATUS_LABEL_KEYS[cls.displayStatus])}
                              </span>
                              <span className="name">{cls.classname}</span>
                              {renderClassMetric(cls)}
                          </div>
                      );
                  })
                : (
                    <div className="entry-rollup">
                        <span className="status-pill" style={{background: statusCss(comp.displayStatus)}}>
                            <StatusIcon status={comp.displayStatus} />
                            {t(STATUS_LABEL_KEYS[comp.displayStatus])}
                        </span>
                        {t('competition.class', {count: comp.classCount})}
                        {totalPilots > 0 ? (
                            <>
                                {' · '}
                                {formatPilotCount(totalPilots, compTracked)}
                            </>
                        ) : null}
                    </div>
                )}
        </div>
    );
}
