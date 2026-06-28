import {displayHeight, displayClimb} from './displayunits';
import {TZ} from '../types';
import type {StatSegment} from '../protobuf/onglide';

type TFn = (key: string, opts?: Record<string, any>) => string;

// Seconds since task start → compact H:MM:SS / M:SS. Used for the "time into
// task" readout on the thermal tooltip.
function formatElapsed(seconds: number): string {
    const sign = seconds < 0 ? '-' : '';
    let s = Math.abs(Math.round(seconds));
    const h = Math.floor(s / 3600);
    s -= h * 3600;
    const m = Math.floor(s / 60);
    s -= m * 60;
    const mm = h ? String(m).padStart(2, '0') : String(m);
    return `${sign}${h ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

export function deckTooltip({
    object,
    picked,
    layer,
    coordinate,
    map,
    pilotStats,
    lang,
    tz,
    units,
    modifierHeld,
    selectedCompno,
    t
}: //
{
    object?: any;
    picked: boolean;
    layer: any;
    coordinate?: number[];
    map: any;
    pilotStats?: Record<string, StatSegment[]>;
    lang: string;
    tz: TZ;
    units: number | boolean;
    modifierHeld?: boolean;
    selectedCompno?: string;
    t: TFn;
}) {
    if (!picked) {
        if (process.env.NODE_ENV == 'development' && coordinate && modifierHeld) {
            return `[${coordinate.map((x) => x.toFixed(4))}, ${map?.queryTerrainElevation({lat: coordinate[1], lng: coordinate[0]}, {exaggerated: false})?.toFixed(0)}]`;
        }
        return null;
    }
    if (object) {
        // Turnpoint
        if (object.type == 'Feature' && object.properties) {
            const tp = object.properties;
            return {html: `<strong>${tp.leg} ${tp.trigraph}</strong>: ${tp.name} 📏 ${tp.r1}${t('units.km')}<br/>`};
        }

        // Thermal marker (thermalLayer) — a focused readout that leads with the
        // climb strength, then duration / height gain / wind. The marker object
        // already carries its StatSegment, so no pilotStats lookup is needed.
        if (layer?.id === 'thermals' && object.stats) {
            const s = object.stats;
            const seconds = s.end - s.start;
            const turn = s.direction === 1 ? ' ↺' : s.direction === 2 ? ' ↻' : '';
            let html = `<strong>${object.compno}</strong> 🌀${turn}<br/>`;
            // When the thermal started: absolute comp-time clock plus, once the
            // pilot has started, the time into the task.
            const clock = new Date(s.start * 1000).toLocaleTimeString(lang, {timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit'});
            const rel = object.utcStart ? ` (+${formatElapsed(s.start - object.utcStart)})` : '';
            html += `🕐 ${clock}${rel}<br/>`;
            html += t('tooltip.thermal_average', {climb: displayClimb(s.avgDelta, units)});
            html += `<br/>${t('tooltip.thermal_for_seconds', {state: s.state, seconds})}`;
            if (s.heightgain) html += `<br/>⬆️ ${displayHeight(s.heightgain, units)}`;
            if (s.wind?.direction) html += `<br/>${t('tooltip.wind', {speed: s.wind.speed?.toFixed(0), direction: s.wind.direction.toFixed(0)})}`;
            return {html};
        }

        // Gaggle marker (gaggleLayer) — how many gliders are sharing this thermal
        // and how each is climbing, best first. The selected glider (if it's in
        // the gaggle) is bolded so you can pick it out of the group.
        if (layer?.id === 'gaggle' && object.members) {
            let html = `<strong>${t('tooltip.gaggle_count', {count: object.count})}</strong><br/>`;
            html += `${t('tooltip.thermal_average', {climb: displayClimb(object.varioAvg, units)})}<br/>`;
            for (const m of object.members) {
                const climb = displayClimb(m.climb, units);
                html += m.compno === selectedCompno ? `<strong>${m.compno}: ${climb}</strong><br/>` : `${m.compno}: ${climb}<br/>`;
            }
            return {html};
        }

        let response = '';
        const compno = layer?.props?.compno ?? object.compno;
        const classLabel = layer?.props?.className ?? object.classname ?? object.class;
        const time = Array.isArray(object.t) ? object.t[1] : object.t;

        if (classLabel) {
            response += `<strong>${compno}</strong>: ${classLabel}<br/>`;
        } else if (compno) {
            response += `<strong>${compno}</strong><br/>`;
        }

        if (time) {
            if (compno && pilotStats?.[compno]?.length) {
                // pilotStats is a single merged, start-sorted segment list, so the
                // segment containing this track point is a direct lookup.
                const segment = pilotStats[compno].find((c) => c.start <= time && time <= c.end);
                if (segment) object.stats = segment;
            }
            // Figure out what the local language is for international date strings
            const dt = new Date(time * 1000);
            response += `✈️ ${dt.toLocaleTimeString(lang, {timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit'})}<br/>`;
        }

        if (process.env.NODE_ENV == 'development') {
            response += `[${time}]<br/>`;
        }
        const a = object.a ?? object.p?.[1]?.[2] ?? NaN;
        if (!isNaN(a)) {
            response += `${displayHeight(a, units)} QNH `;
        }
        if (object.g && !isNaN(object.g)) {
            response += `(${displayHeight(object.g, units)} AGL) `;
        }
        if (object.v) {
            if (typeof object.v !== 'number') {
                const average = object.v.split(',').map((a) => parseFloat(a))?.[3];
                response += ` ↕️  ${displayClimb(average, units)}`;
            } else {
                response += ` ↕️  ${displayClimb(object.v, units)}`;
            }
        }
        if (object.b) {
            response += `${object.b} °`;
        }

        if (object.stats) {
            const stats = object.stats;
            const elapsed = stats.end - stats.start;

            if (elapsed > 30) {
                response += `<br/> ${t('tooltip.thermal_for_seconds', {state: stats.state, seconds: elapsed})}<br/>`;

                if (stats.state == 'thermal') {
                    response += t('tooltip.thermal_average', {climb: displayClimb(stats.avgDelta, units)});
                } else if (stats.state == 'straight') {
                    response +=
                        t('tooltip.straight_distance_speed', {distance: stats.distance, speed: (stats.distance / (elapsed / 3600)).toFixed(0)}) +
                        '<br/>' +
                        t('tooltip.straight_ld', {ld: ((stats.distance * 1000) / -stats.delta).toFixed(1)});
                }
                if (stats.wind?.direction) {
                    response += `<br/>${t('tooltip.wind', {speed: stats.wind.speed?.toFixed(0), direction: stats.wind.direction.toFixed(0)})}`;
                }
            }
        }
        return {html: response};
    } else if (layer && layer.props.tt == true) {
        return layer.compno ?? layer.id;
    } else {
        return null;
    }
}
