import {displayHeight, displayClimb} from './displayunits';
import {TZ, PilotStatsEntry} from '../types';

type TFn = (key: string, opts?: Record<string, any>) => string;

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
    t
}: //
{
    object?: any;
    picked: boolean;
    layer: any;
    coordinate?: number[];
    map: any;
    pilotStats?: Record<string, PilotStatsEntry[]>;
    lang: string;
    tz: TZ;
    units: number | boolean;
    modifierHeld?: boolean;
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
            html += t('tooltip.thermal_average', {climb: displayClimb(s.avgDelta, units)});
            html += `<br/>${t('tooltip.thermal_for_seconds', {state: s.state, seconds})}`;
            if (s.heightgain) html += `<br/>⬆️ ${displayHeight(s.heightgain, units)}`;
            if (s.wind?.direction) html += `<br/>${t('tooltip.wind', {speed: s.wind.speed?.toFixed(0), direction: s.wind.direction.toFixed(0)})}`;
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
                // Find the latest stats snapshot at or before this track point's time,
                // then look up which segment contains the point.
                const entries = pilotStats[compno];
                let ei = entries.length - 1;
                while (ei > 0 && entries[ei].t > time) ei--;
                const segment = entries[ei]?.segments.find((c) => c.start <= time && time <= c.end);
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
