import {useEffect, useState, useRef, useCallback} from 'react';
import {useRouter} from 'next/router';

import {prepareApiTask, type PreparedTask} from '../view/apiTask';
import type {API_ClassName_Task} from '../rest-api-types';

export type ApiTaskState = 'idle' | 'loading' | 'loaded' | 'none' | 'error';

export interface ApiTaskHandle {
    /** Fetch lifecycle for the ?className= competition task. */
    state: ApiTaskState;
    /** The class asked for in the URL, once the router has resolved it. */
    className: string | undefined;
    /**
     * Non-null once loaded. Each call prepares a fresh working copy from the
     * pristine raw JSON (calculateTask + geoJSON). calculateTask mutates leg
     * lengths destructively, so a used copy must never be re-prepared —
     * call seed() again instead (that is all a reset needs to do).
     */
    seed: (() => PreparedTask) | null;
}

// Fetches /api/[className]/task when the page is opened with ?className= —
// the "open in viewer" link on the live page. 204 (no task today) and fetch
// failures surface as state so the caller can fall back to IGC declarations.
export function useApiTask(): ApiTaskHandle {
    const router = useRouter();
    const queryClassName = router.query.className;
    const className = Array.isArray(queryClassName) ? queryClassName[0] : queryClassName;

    const [state, setState] = useState<ApiTaskState>('idle');
    const rawRef = useRef<API_ClassName_Task['task'] | null>(null);

    useEffect(() => {
        if (!router.isReady || !className || state !== 'idle') {
            return;
        }
        setState('loading');
        fetch(`/api/${encodeURIComponent(className)}/task`)
            .then(async (response) => {
                if (response.status === 204) {
                    setState('none');
                    return;
                }
                if (!response.ok) {
                    throw new Error(`api/task ${response.status}`);
                }
                const json: API_ClassName_Task = await response.json();
                rawRef.current = json.task;
                setState('loaded');
            })
            .catch((e) => {
                console.log(`api/task fetch failed for ${className}`, e);
                setState('error');
            });
    }, [router.isReady, className, state]);

    const seed = useCallback(() => prepareApiTask(rawRef.current!), []);

    return {state, className, seed: state === 'loaded' ? seed : null};
}
