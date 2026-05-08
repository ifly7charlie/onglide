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

import {STATUS_COLOURS, STATUS_LABEL_KEYS, StatusIcon, statusCss, statusIconDataUrl, type CompetitionDisplayStatus} from './competition-status';
import {classKey, useStatusSummary, type StatusSummary} from './statusSummary';
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
    classCount: number;
    classes?: CompetitionClass[];
    classStatusesDiffer?: boolean;
    displayStatus: CompetitionDisplayStatus;
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
    const zoom = span < 5 ? 3.5 : span < 15 ? 2.5 : span < 40 ? 1.5 : 0.5;
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
        () => competitions.filter((c) => typeof c.lat === 'number' && typeof c.lng === 'number' && Number.isFinite(c.lat) && Number.isFinite(c.lng)),
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
    const flyTo = useCallback((comp: Competition) => {
        if (typeof comp.lat !== 'number' || typeof comp.lng !== 'number') return;
        setViewState((prev: any) => ({
            ...prev,
            longitude: comp.lng,
            latitude: comp.lat,
            zoom: Math.max(prev.zoom ?? 1, 3.5),
            transitionDuration: 1000,
            transitionInterpolator: new FlyToInterpolator({speed: 1.2})
        }));
    }, []);

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
            data: visibleCompetitions,
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
                getFillColor: [visibleCompetitions],
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
            data: visibleCompetitions,
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
                getIcon: [visibleCompetitions],
                getSize: [highlightedCompid]
            }
        });

        // SDF font is required whenever outlineWidth > 0; characterSet: 'auto'
        // handles non-ASCII glyphs in competition names.
        const labels = new TextLayer<Competition>({
            id: 'competition-labels',
            data: visibleCompetitions,
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
    }, [visibleCompetitions, countriesGeoJson, highlightedCompid]);

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
            <DeckGL
                views={new GlobeView({id: 'globe', resolution: 10}) as any}
                viewState={viewState as any}
                onViewStateChange={({viewState: v}: any) => setViewState(v)}
                controller={hasData}
                effects={effects as any}
                parameters={{cull: true} as any}
                layers={layers}
            />

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
                competitions={competitions}
                highlightedCompid={highlightedCompid}
                setHighlightedCompid={setHighlightedCompid}
                flyTo={flyTo}
                entryRefs={entryRefs}
            />

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
    competitions,
    highlightedCompid,
    setHighlightedCompid,
    flyTo,
    entryRefs
}: {
    competitions: Competition[];
    highlightedCompid: string | null;
    setHighlightedCompid: (id: string | null) => void;
    flyTo: (c: Competition) => void;
    entryRefs: React.MutableRefObject<Map<string, HTMLDivElement | null>>;
}) {
    // All hooks must run on every render — call them before any early return,
    // otherwise the hook order changes between renders and React errors out.
    const {t} = useTranslation('common');
    const summary = useStatusSummary();
    if (!competitions.length) return null;

    // Group competitions into Live / Upcoming so users can tell at a glance
    // which ones are clickable. Upcoming entries stay in the list (so pilots
    // can find their comp) but navigation is disabled.
    // Within Live, rank by the most active status across the comp's classes
    // (finishing > racing > launching > task set > home > no task), then by
    // viewers desc, then by registered pilot count desc.
    const STATUS_RANK: Record<CompetitionDisplayStatus, number> = {
        finishing: 0,
        started: 1,
        launching: 2,
        task_set: 3,
        home: 4,
        notask: 5,
        yesterday: 6,
        upcoming: 7
    };
    const pilotCount = (c: Competition) => (c.classes ?? []).reduce((s, cls) => s + (cls.pilotCount || 0), 0);
    const compRank = (c: Competition) => {
        const classes = c.classes ?? [];
        if (!classes.length) return STATUS_RANK[c.displayStatus] ?? 99;
        return Math.min(...classes.map((cls) => STATUS_RANK[cls.displayStatus] ?? 99));
    };
    const live = competitions
        .filter((c) => c.displayStatus !== 'upcoming')
        .sort((a, b) => {
            const ra = compRank(a);
            const rb = compRank(b);
            if (ra !== rb) return ra - rb;
            const va = summary?.byComp.get(a.compid)?.viewers ?? 0;
            const vb = summary?.byComp.get(b.compid)?.viewers ?? 0;
            if (va !== vb) return vb - va;
            return pilotCount(b) - pilotCount(a);
        });
    const upcoming = competitions.filter((c) => c.displayStatus === 'upcoming');

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
    // status dot + class name + pilot count on each line. Upcoming shows a
    // compact rollup — "N classes · M pilots" — because the per-class detail
    // isn't interesting yet.
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

    return (
        <div ref={registerRef} onMouseEnter={onHover} onMouseLeave={onLeave} onClick={onClick} className={entryClass}>
            <div className="entry-title">{comp.name}</div>
            {comp.sitename ? <div className="entry-sitename">{comp.sitename}</div> : null}
            <div className="entry-dates">
                {comp.start} – {comp.end}
            </div>
            {inActiveWindow && classes.length > 0
                ? classes.map((cls) => {
                      const classTracked = summary?.byClass.get(classKey(comp.compid, cls.class))?.tracked;
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
                              <span className="count">{formatPilotCount(cls.pilotCount, classTracked)}</span>
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
