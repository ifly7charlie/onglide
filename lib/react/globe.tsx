import {useMemo, useState, useCallback, useEffect, useRef} from 'react';
import Router from 'next/router';

import {DeckGL} from '@deck.gl/react';
import {_GlobeView as GlobeView, COORDINATE_SYSTEM, LightingEffect, AmbientLight, _SunLight as SunLight, FlyToInterpolator} from '@deck.gl/core';
import {GeoJsonLayer, ScatterplotLayer, TextLayer} from '@deck.gl/layers';
import {SimpleMeshLayer} from '@deck.gl/mesh-layers';
import {SphereGeometry} from '@luma.gl/engine';

// Earth radius in metres — matches the radius deck.gl's GlobeView uses
// internally for its projection math, so a sphere mesh of this size lines
// up exactly with marker/label positions placed via lat/lng.
const EARTH_RADIUS_METERS = 6.3e6;

export type CompetitionDisplayStatus = 'task_set' | 'before_start' | 'started' | 'landed' | 'notask' | 'upcoming';

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

// Marker colours per status. Kept here so the legend and markers stay in sync.
const STATUS_COLOURS: Record<CompetitionDisplayStatus, [number, number, number, number]> = {
    task_set: [100, 200, 240, 255], // light blue — task briefed, waiting to launch
    before_start: [30, 90, 220, 255], // dark blue — in air, no class has started yet
    started: [40, 220, 90, 255], // green — at least one class is on task
    landed: [150, 150, 150, 255], // grey — done for the day
    notask: [200, 170, 100, 255], // dusty tan — in window but no task yet
    upcoming: [200, 140, 200, 255] // lilac — starts tomorrow or later
};

const STATUS_LABELS: Record<CompetitionDisplayStatus, string> = {
    task_set: 'Task set',
    before_start: 'Flying, before start',
    started: 'Started',
    landed: 'Landed',
    notask: 'No task yet',
    upcoming: 'Upcoming'
};

// Inline style helper: returns the `rgb(r,g,b)` string for a status so the
// same palette is used in the marker layer AND the DOM list dots.
function statusCss(status: CompetitionDisplayStatus): string {
    const [r, g, b] = STATUS_COLOURS[status];
    return `rgb(${r},${g},${b})`;
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
    const [highlightedCompid, setHighlightedCompid] = useState<string | null>(null);

    // Refs to each list entry, keyed by compid, so clicking a marker on the
    // globe can scroll the corresponding row into view in the side panel.
    const entryRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
    const revealCompid = useCallback((compid: string) => {
        setHighlightedCompid(compid);
        entryRefs.current.get(compid)?.scrollIntoView({behavior: 'smooth', block: 'nearest'});
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
            onHover: (info) => setHighlightedCompid(((info.object as Competition) ?? null)?.compid ?? null),
            updateTriggers: {
                getFillColor: [visibleCompetitions],
                getLineColor: [highlightedCompid],
                getRadius: [highlightedCompid],
                getLineWidth: [highlightedCompid]
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

        return [earthSphere, countries, markers, labels].filter(Boolean) as any[];
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
            {hasData ? (
                <DeckGL
                    views={new GlobeView({id: 'globe', resolution: 10}) as any}
                    viewState={viewState as any}
                    onViewStateChange={({viewState: v}: any) => setViewState(v)}
                    controller={true}
                    effects={effects as any}
                    parameters={{cull: true} as any}
                    layers={layers}
                />
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
                {(['upcoming', 'notask', 'task_set', 'before_start', 'started', 'landed'] as const).map((s) => (
                    <div key={s} className="legend-row">
                        <span className="status-dot" style={{background: statusCss(s)}} />
                        {STATUS_LABELS[s]}
                    </div>
                ))}
            </div>

            <div className="map-attribution">
                Land data:{' '}
                <a href="https://www.naturalearthdata.com/" target="_blank" rel="noopener noreferrer">
                    Natural Earth
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
    if (!competitions.length) return null;

    // Group competitions into Live / Upcoming so users can tell at a glance
    // which ones are clickable. Upcoming entries stay in the list (so pilots
    // can find their comp) but navigation is disabled.
    const live = competitions.filter((c) => c.displayStatus !== 'upcoming');
    const upcoming = competitions.filter((c) => c.displayStatus === 'upcoming');

    const renderSection = (title: string, comps: Competition[], clickable: boolean) => {
        if (!comps.length) return null;
        return (
            <>
                <div className="sidepanel-section-header">
                    {title} · {comps.length}
                </div>
                {comps.map((c) => (
                    <CompetitionListEntry
                        key={c.compid}
                        comp={c}
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

    return (
        <aside className="sidepanel sidepanel-globe">
            <div className="sidepanel-body">
                {renderSection('Live', live, true)}
                {renderSection('Upcoming', upcoming, false)}
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
    highlighted,
    clickable,
    registerRef,
    onHover,
    onLeave,
    onClick
}: {
    comp: Competition;
    highlighted: boolean;
    clickable: boolean;
    registerRef: (el: HTMLDivElement | null) => void;
    onHover: () => void;
    onLeave: () => void;
    onClick: () => void;
}) {
    const classes = comp.classes ?? [];

    // Competitions in their active window get a per-class breakdown with
    // status dot + class name + pilot count on each line. Upcoming shows a
    // compact rollup — "N classes · M pilots" — because the per-class detail
    // isn't interesting yet.
    const inActiveWindow = comp.displayStatus !== 'upcoming';
    const totalPilots = classes.reduce((sum, cls) => sum + (cls.pilotCount || 0), 0);

    const entryClass = ['sidepanel-entry', highlighted ? 'highlighted' : '', !clickable ? 'non-clickable' : ''].filter(Boolean).join(' ');

    return (
        <div ref={registerRef} onMouseEnter={onHover} onMouseLeave={onLeave} onClick={onClick} className={entryClass}>
            <div className="entry-title">{comp.name}</div>
            {comp.sitename ? <div className="entry-sitename">{comp.sitename}</div> : null}
            <div className="entry-dates">
                {comp.start} – {comp.end}
            </div>
            {inActiveWindow && classes.length > 0
                ? classes.map((cls) => (
                      <div
                          key={cls.class}
                          className="entry-classrow"
                          onClick={(e) => {
                              e.stopPropagation();
                              Router.push('/' + comp.compid + '?className=' + cls.class);
                          }}
                      >
                          <span className="status-pill" style={{background: statusCss(cls.displayStatus)}}>
                              {STATUS_LABELS[cls.displayStatus]}
                          </span>
                          <span className="name">{cls.classname}</span>
                          <span className="count">
                              {cls.pilotCount} {cls.pilotCount === 1 ? 'pilot' : 'pilots'}
                          </span>
                      </div>
                  ))
                : (
                    <div className="entry-rollup">
                        <span className="status-pill" style={{background: statusCss(comp.displayStatus)}}>
                            {STATUS_LABELS[comp.displayStatus]}
                        </span>
                        {comp.classCount} {comp.classCount === 1 ? 'class' : 'classes'}
                        {totalPilots > 0 ? (
                            <>
                                {' · '}
                                {totalPilots} {totalPilots === 1 ? 'pilot' : 'pilots'}
                            </>
                        ) : null}
                    </div>
                )}
        </div>
    );
}
