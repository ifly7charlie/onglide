import {faPlane, faPlaneDeparture, faFlagCheckered, faCalendar, faHourglass, faRoute} from '@fortawesome/free-solid-svg-icons';
import type {IconDefinition} from '@fortawesome/fontawesome-svg-core';

// Lifecycle of a soaring competition's display state through the day:
//
//   upcoming     — starts tomorrow or later
//   notask       — window is open today, but no class has a task configured
//   task_set     — task briefed, waiting to launch (status B/P)
//   before_start — at least one class is launched but none have started (L)
//   started      — at least one class has crossed the start line (S)
//   landed       — all classes finished for the day (R/H/O)
//
// Used by the front-page globe markers and legend AND by the per-competition
// page's class tab buttons, so a class shown as "started" on the globe stays
// "started" once the user clicks through.
//
export type CompetitionDisplayStatus = 'task_set' | 'before_start' | 'started' | 'landed' | 'notask' | 'upcoming';

export const STATUS_COLOURS: Record<CompetitionDisplayStatus, [number, number, number, number]> = {
    task_set: [100, 200, 240, 255],
    before_start: [30, 90, 220, 255],
    started: [40, 220, 90, 255],
    landed: [150, 150, 150, 255],
    notask: [200, 170, 100, 255],
    upcoming: [200, 140, 200, 255]
};

export const STATUS_LABELS: Record<CompetitionDisplayStatus, string> = {
    task_set: 'Task set',
    before_start: 'Flying, before start',
    started: 'Started',
    landed: 'Landed',
    notask: 'No task yet',
    upcoming: 'Upcoming'
};

export const STATUS_ICONS: Record<CompetitionDisplayStatus, IconDefinition> = {
    task_set: faRoute,
    before_start: faPlaneDeparture,
    started: faPlane,
    landed: faFlagCheckered,
    notask: faHourglass,
    upcoming: faCalendar
};

export function statusCss(status: CompetitionDisplayStatus): string {
    const [r, g, b] = STATUS_COLOURS[status];
    return `rgb(${r},${g},${b})`;
}

// Derive a displayStatus from a single class's compstatus.status code plus
// the competition window. `endPast` short-circuits the "upcoming" fallback
// when the comp's end date has already passed.
export function classDisplayStatus(status: string, inWindow: boolean, endPast: boolean): CompetitionDisplayStatus {
    if (status === 'S') return 'started';
    if (status === 'L') return 'before_start';
    if (status === 'R' || status === 'H' || status === 'O') return 'landed';
    if (inWindow && (status === 'B' || status === 'P')) return 'task_set';
    if (inWindow) return 'notask';
    if (endPast) return 'landed';
    return 'upcoming';
}

// Build an SVG data URL for a FontAwesome icon, useful as a deck.gl IconLayer
// source. `colour` is any CSS colour string. We embed the raw path data into
// a fresh <svg> wrapper rather than using fontawesome-svg-core's renderer so
// the call is synchronous and tree-shakes cleanly.
export function statusIconDataUrl(status: CompetitionDisplayStatus, colour: string): string {
    const def = STATUS_ICONS[status];
    const [width, height, , , pathRaw] = def.icon;
    const path = Array.isArray(pathRaw) ? pathRaw.join(' ') : (pathRaw as string);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"><path fill="${colour}" d="${path}"/></svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
