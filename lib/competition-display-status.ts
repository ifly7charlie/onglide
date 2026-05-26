// Pure (non-JSX) helpers shared between the front-end and the OGN daemon.
// The richer competition-status.tsx (icons, colours, React components) lives
// alongside this and re-exports the type and function below.

import {CompStatus} from './types';

export type CompetitionDisplayStatus = 'task_set' | 'launching' | 'started' | 'finishing' | 'home' | 'notask' | 'upcoming' | 'yesterday' | 'cancelled';

// Derive a displayStatus from a single class's compstatus.status code plus
// the competition window. Callers must filter out comps whose end date has
// passed before calling this — there is no post-end fallback here.
export function classDisplayStatus(status: string, inWindow: boolean): CompetitionDisplayStatus {
    if (status === CompStatus.FirstFinisher) return 'finishing';
    if (status === CompStatus.StartOpen) return 'started';
    if (status === CompStatus.Launched) return 'launching';
    if (status === CompStatus.AllHome) return 'home';
    if (status === CompStatus.Scrubbed) return 'cancelled';
    if (status === CompStatus.AfterBrief || status === CompStatus.Gridded) return 'task_set';
    if (inWindow) return 'notask';
    return 'upcoming';
}
