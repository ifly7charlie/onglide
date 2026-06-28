import {memo} from 'react';
import {useTranslation} from 'next-i18next/pages';
import {TooltipIcon} from './htmlhelper';

import {Epoch, TZ} from '../types';
import type {StatSegment} from '../protobuf/onglide';

import {OptionalTime} from './optional';
import {displayClimb, displayHeight} from './displayunits';

import {
    //
    faArrowRight,
    faArrowUp,
    faEllipsis
} from '@fortawesome/free-solid-svg-icons';

// Compact duration: "45s", "3m20", "1h05" — readable in a narrow cell where the
// HH:MM:SS form (00:03:20) wastes width on leading zeros.
function compactDuration(seconds: number): string {
    const s = Math.max(0, Math.round(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h) return `${h}h${m.toString().padStart(2, '0')}`;
    if (m) return `${m}m${sec.toString().padStart(2, '0')}`;
    return `${sec}s`;
}

// Per-segment flight statistics — the web rendering of `bin/dumpstats.ts`'s
// printSegment: one row per thermal/glide/gap with the same metrics, plus a
// summary line of the thermal count and climb/gain totals.
export const FlightStatsSegments = memo(function FlightStatsSegments({segments, utcStart, scoredDistance, replayTime, units, tz}: {segments: StatSegment[]; utcStart?: Epoch; scoredDistance?: number; replayTime?: Epoch; units: boolean; tz: TZ}) {
    const {t} = useTranslation('common');

    const segDuration = (s: StatSegment) => (s.end ?? 0) - (s.start ?? 0);

    // Clip the segment list to the visible window: drop the pre-start phase
    // (sniffing / gaggle thermalling) once the pilot has a start time, and — when
    // replaying — drop anything not yet begun at the replay cursor.
    const shown = segments.filter((s) => {
        if (utcStart && (s.end ?? 0) <= utcStart) return false;
        if (replayTime && (s.start ?? 0) > replayTime) return false;
        return true;
    });

    const thermals = shown.filter((s) => s.state == 'thermal');
    const bestClimb = thermals.reduce((m, s) => Math.max(m, s.avgDelta ?? 0), 0);
    const avgClimb = thermals.length ? thermals.reduce((a, s) => a + (s.avgDelta ?? 0), 0) / thermals.length : 0;
    const totalGain = shown.reduce((a, s) => a + (s.heightgain ?? 0), 0);

    // Fraction of flown (non-gap) time spent thermalling — tracking gaps are
    // excluded from the denominator since we don't know what happened in them.
    const thermalTime = thermals.reduce((a, s) => a + segDuration(s), 0);
    const flownTime = shown.reduce((a, s) => a + (s.state == 'gap' ? 0 : segDuration(s)), 0);
    const pctThermal = flownTime > 0 ? Math.round((thermalTime / flownTime) * 100) : 0;

    // Out-of-coverage fraction is gap time over the whole window (gaps included).
    const totalTime = shown.reduce((a, s) => a + segDuration(s), 0);
    const pctGap = totalTime > 0 ? Math.round(((totalTime - flownTime) / totalTime) * 100) : 0;

    // Aggregate glide ratio across the glides: total horizontal distance over
    // total height lost (weighted by distance, not a mean of per-segment ratios).
    const straights = shown.filter((s) => s.state != 'thermal' && s.state != 'gap');
    const straightDist = straights.reduce((a, s) => a + (s.distance ?? 0), 0); // km
    const straightLoss = straights.reduce((a, s) => a + -(s.delta ?? (s.heightgain ?? 0) - (s.heightloss ?? 0)), 0); // m net lost
    const avgLD = straightLoss > 0 ? (straightDist * 1000) / straightLoss : null;
    const ldStr = avgLD == null ? '–' : avgLD < 999 ? avgLD.toFixed(1) : '∞';

    // Total distance actually flown: the tracked path length of every flown
    // segment (thermal circling included) plus a straight-line estimate across
    // each coverage gap, so it's comparable to the scored task distance which
    // spans those gaps. The increment is how much further the pilot flew than
    // the (actual, not handicapped) scored distance, as a percentage of it —
    // the circling and detour cost.
    const km = t('units.km');
    const flownDist = shown.reduce((a, s) => a + (s.state == 'gap' ? (s.achievedDistance ?? 0) : (s.distance ?? 0)), 0);
    const extraPct = scoredDistance && scoredDistance > 0 ? ((flownDist - scoredDistance) / scoredDistance) * 100 : null;
    const flownClause =
        extraPct == null //
            ? t('flight_stats.flown', {dist: `${Math.round(flownDist)}${km}`})
            : t('flight_stats.flown_with_extra', {dist: `${Math.round(flownDist)}${km}`, extra: `${extraPct >= 0 ? '+' : ''}${Math.round(extraPct)}%`});

    const stateIcon = (state: string) => {
        if (state == 'thermal') return <TooltipIcon icon={faArrowUp} tooltip={t('flight_stats.state_thermal')} />;
        if (state == 'gap') return <TooltipIcon icon={faEllipsis} tooltip={t('flight_stats.state_gap')} />;
        return <TooltipIcon icon={faArrowRight} tooltip={t('flight_stats.state_straight')} />;
    };

    // The detail of each segment, split into three fixed columns so values line
    // up vertically. Thermal: climb / height gain / turns. Glide: distance /
    // height delta / L/D. Gap: a single note in the first column.
    const detailCols = (s: StatSegment) => {
        if (s.state == 'thermal') {
            const turns = s.turncount ? Math.round(s.turncount / 360) : 0;
            // Arrow shows direction, magnitude is unsigned (▼ 0.4m/s, not ▼ -0.4m/s).
            return [`${(s.avgDelta ?? 0) < 0 ? '▼' : '▲'} ${displayClimb(Math.abs(s.avgDelta ?? 0), units)}`, s.heightgain ? `+${displayHeight(s.heightgain, units)}` : '', turns ? t('flight_stats.turns', {count: turns}) : ''];
        }
        if (s.state == 'gap') {
            return [t('flight_stats.tracking_gap'), '', ''];
        }
        // straight / start — a glide
        const delta = s.delta ?? (s.heightgain ?? 0) - (s.heightloss ?? 0);
        const ld = delta < 0 ? ((s.distance * 1000) / -delta).toFixed(1) : null;
        return [s.distance ? `${s.distance}${t('units.km')}` : '', `Δ${delta >= 0 ? '+' : ''}${displayHeight(delta, units)}`, ld ? t('tooltip.straight_ld', {ld}) : ''];
    };

    return (
        <>
            <br style={{clear: 'both'}} />
            <div className="stats-summary">{t('flight_stats.summary', {thermals: thermals.length, pct: pctThermal, best: displayClimb(bestClimb, units), avg: displayClimb(avgClimb, units)})}</div>
            <div className="stats-summary">{t('flight_stats.summary2', {ld: ldStr, flown: flownClause, gain: displayHeight(totalGain, units), pctGap})}</div>
            <table className="stats-segments">
                <thead>
                    <tr>
                        <td className="stat-type">&nbsp;</td>
                        <td>{t('flight_stats.col_time')}</td>
                        <td>{t('flight_stats.col_duration')}</td>
                        <td />
                        <td />
                        <td />
                        <td>{t('flight_stats.col_wind')}</td>
                    </tr>
                </thead>
                <tbody>
                    {shown
                        .slice()
                        .reverse()
                        .map((s) => {
                            const [d1, d2, d3] = detailCols(s);
                            return (
                                <tr key={s.start} className={`stat-row stat-${s.state}`}>
                                    <td className="stat-type">{stateIcon(s.state)}</td>
                                    <td>{OptionalTime('', s.start as Epoch, tz)}</td>
                                    <td>{compactDuration(segDuration(s))}</td>
                                    <td className="stat-detail">{d1}</td>
                                    <td className="stat-detail">{d2}</td>
                                    <td className="stat-detail">{d3}</td>
                                    <td>{s.wind?.direction ? `${Math.round(s.wind.speed ?? 0)}${t('units.kph')}@${Math.round(s.wind.direction)}°` : ''}</td>
                                </tr>
                            );
                        })}
                </tbody>
            </table>
        </>
    );
});
