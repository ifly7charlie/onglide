import * as React from 'react';
import {FontAwesomeIcon} from '@fortawesome/react-fontawesome';
import {faPlane, faPlaneDeparture, faFlagCheckered, faHouse, faCalendar, faClockRotateLeft, faHourglass, faRoute} from '@fortawesome/free-solid-svg-icons';
import type {IconDefinition} from '@fortawesome/fontawesome-svg-core';

// Lifecycle of a soaring competition's display state through the day:
//
//   upcoming  — starts tomorrow or later
//   notask    — window is open today, but no class has a task configured
//   task_set  — task briefed, pilots prepping or gridded (status B/P/G)
//   launching — at least one class is being launched (status L)
//   started   — at least one class has crossed the start line (S)
//   finishing — at least one class has its first finisher within ~5 min of home (F)
//   home      — all classes back at home base (H)
//   yesterday — last task was yesterday and nothing's happening today yet
//
// Comps whose end date has passed are filtered out by the caller and never
// reach this display layer.
//
// Used by the front-page globe markers and legend AND by the per-competition
// page's class tab buttons, so a class shown as "started" on the globe stays
// "started" once the user clicks through.
//
export type CompetitionDisplayStatus = 'task_set' | 'launching' | 'started' | 'finishing' | 'home' | 'notask' | 'upcoming' | 'yesterday';

export const STATUS_COLOURS: Record<CompetitionDisplayStatus, [number, number, number, number]> = {
    task_set: [100, 200, 240, 255],
    launching: [30, 90, 220, 255],
    started: [40, 220, 90, 255],
    finishing: [240, 180, 40, 255],
    home: [150, 150, 150, 255],
    notask: [200, 170, 100, 255],
    upcoming: [200, 140, 200, 255],
    yesterday: [100, 140, 170, 255]
};

// Maps each display status to its translation key under the `task_status`
// namespace in common.json. Callers should pass these keys through `t()`
// (or use the `useStatusLabel` helper) to render them.
export const STATUS_LABEL_KEYS: Record<CompetitionDisplayStatus, string> = {
    task_set: 'task_status.task_set',
    launching: 'task_status.launching',
    started: 'task_status.racing',
    finishing: 'task_status.finishing',
    home: 'task_status.home',
    notask: 'task_status.no_task',
    upcoming: 'task_status.upcoming',
    yesterday: 'task_status.yesterday'
};

export const STATUS_ICONS: Record<CompetitionDisplayStatus, IconDefinition> = {
    task_set: faRoute,
    launching: faPlaneDeparture,
    started: faPlane,
    finishing: faFlagCheckered,
    home: faHouse,
    notask: faHourglass,
    upcoming: faCalendar,
    yesterday: faClockRotateLeft
};

// Optional secondary icon, drawn small in the bottom-right corner of the
// primary. Currently no statuses use an overlay — kept as an extension point.
const STATUS_ICON_OVERLAYS: Partial<Record<CompetitionDisplayStatus, IconDefinition>> = {};

export function statusCss(status: CompetitionDisplayStatus): string {
    const [r, g, b] = STATUS_COLOURS[status];
    return `rgb(${r},${g},${b})`;
}

// Derive a displayStatus from a single class's compstatus.status code plus
// the competition window. Callers must filter out comps whose end date has
// passed before calling this — there is no post-end fallback here.
export function classDisplayStatus(status: string, inWindow: boolean): CompetitionDisplayStatus {
    if (status === 'F') return 'finishing';
    if (status === 'S') return 'started';
    if (status === 'L') return 'launching';
    if (status === 'H') return 'home';
    if (inWindow && (status === 'B' || status === 'P' || status === 'G')) return 'task_set';
    if (inWindow) return 'notask';
    return 'upcoming';
}

function iconPathString(def: IconDefinition): string {
    const raw = def.icon[4];
    return Array.isArray(raw) ? raw.join(' ') : (raw as string);
}

// Build an SVG data URL for a FontAwesome icon, useful as a deck.gl IconLayer
// source. `colour` is any CSS colour string. For statuses with an overlay
// icon we composite both into one SVG and stroke the overlay so it stays
// readable when both icons share the same fill colour.
export function statusIconDataUrl(status: CompetitionDisplayStatus, colour: string): string {
    const def = STATUS_ICONS[status];
    const [width, height] = def.icon;
    const path = iconPathString(def);
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">`;
    svg += `<path fill="${colour}" d="${path}"/>`;

    const overlay = STATUS_ICON_OVERLAYS[status];
    if (overlay) {
        const [oW, oH] = overlay.icon;
        const oPath = iconPathString(overlay);
        const overlaySize = Math.min(width, height) * 0.55;
        const sx = overlaySize / oW;
        const sy = overlaySize / oH;
        const tx = width - oW * sx;
        const ty = height - oH * sy;
        // paint-order=stroke draws the dark halo first, so the overlay stays
        // distinguishable from the primary icon when both are the same colour.
        svg += `<g transform="translate(${tx},${ty}) scale(${sx},${sy})">`;
        svg += `<path fill="${colour}" stroke="rgba(0,0,0,0.65)" stroke-width="60" stroke-linejoin="round" paint-order="stroke" d="${oPath}"/>`;
        svg += `</g>`;
    }

    svg += `</svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

// Small wrapper that renders the FontAwesome icon for a status, plus a
// stacked overlay icon when one is defined. CSS positioning lives in
// `.status-icon-stack` (styles/onglide.scss).
export function StatusIcon({status, className}: {status: CompetitionDisplayStatus; className?: string}) {
    const primary = STATUS_ICONS[status];
    const overlay = STATUS_ICON_OVERLAYS[status];
    if (!overlay) {
        return <FontAwesomeIcon icon={primary} className={className} />;
    }
    return (
        <span className={`status-icon-stack${className ? ' ' + className : ''}`}>
            <FontAwesomeIcon icon={primary} />
            <FontAwesomeIcon icon={overlay} className="status-icon-overlay" />
        </span>
    );
}
