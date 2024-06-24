import {displayHeight, displayClimb} from './displayunits';
import {TZ, ScoreData} from '../types';

export function deckTooltip({
    object,
    picked,
    layer,
    coordinate,
    map,
    pilotScores,
    lang,
    tz,
    units
}: //
{
    object?: any;
    picked: boolean;
    layer: any;
    coordinate?: number[];
    map: any;
    pilotScores: ScoreData;
    lang: string;
    tz: TZ;
    units: number | boolean;
}) {
    if (!picked) {
        if (process.env.NODE_ENV == 'development' && coordinate) {
            return `[${coordinate.map((x) => x.toFixed(4))}, ${map
                ?.queryTerrainElevation({lat: coordinate[1], lng: coordinate[0]}, {exaggerated: false})
                ?.toFixed(0)}]`;
        }
        return null;
    }
    if (object) {
        // Turnpoint
        if (object.type == 'Feature' && object.properties) {
            const tp = object.properties;
            return {html: `<strong>${tp.leg} ${tp.trigraph}</strong>: ${tp.name} 📏 ${tp.r1}km<br/>`};
        }

        let response = '';
        const compno = layer?.props?.compno ?? object.compno;
        const className = layer?.props?.className ?? object.className;
        const time = Array.isArray(object.t) ? object.t[1] : object.t;

        if (className) {
            response += `<strong>${compno}</strong>: ${className}<br/>`;
        } else if (compno) {
            response += `<strong>${compno}</strong><br/>`;
        }

        if (time) {
            if (compno && pilotScores[compno]?.stats?.segments) {
                const segment = pilotScores[compno].stats?.segments.find((c) => c.start <= time && time <= c.end);
                if (segment) {
                    object.stats = segment;
                }
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
                response += `<br/> ${stats.state} for ${elapsed} seconds<br/>`;

                if (stats.state == 'thermal') {
                    response += `average: ${displayClimb(stats.avgDelta, units)}`;
                } else if (stats.state == 'straight') {
                    response +=
                        `distance: ${stats.distance} km at a speed of ${(stats.distance / (elapsed / 3600)).toFixed(0)} kph<br/>` +
                        `L/D ${((stats.distance * 1000) / -stats.delta).toFixed(1)}`;
                }
                if (stats.wind.direction) {
                    response += `<br/>wind speed: ${stats.wind.speed.toFixed(0)} kph @ ${stats.wind.direction.toFixed(0)}°`;
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
