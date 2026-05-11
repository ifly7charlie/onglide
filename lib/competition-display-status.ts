// Pure (non-JSX) helpers shared between the front-end and the OGN daemon.
// The richer competition-status.tsx (icons, colours, React components) lives
// alongside this and re-exports the type and function below.

export type CompetitionDisplayStatus = 'task_set' | 'launching' | 'started' | 'finishing' | 'home' | 'notask' | 'upcoming' | 'yesterday';

// Derive a displayStatus from a single class's compstatus.status code plus
// the competition window. Callers must filter out comps whose end date has
// passed before calling this — there is no post-end fallback here.
export function classDisplayStatus(status: string, inWindow: boolean): CompetitionDisplayStatus {
    if (status === 'F') return 'finishing';
    if (status === 'S') return 'started';
    if (status === 'L') return 'launching';
    if (status === 'H') return 'home';
    if (status === 'B' || status === 'P' || status === 'G') return 'task_set';
    if (inWindow) return 'notask';
    return 'upcoming';
}
