//
//
// Helper functions for loading data from APIs
//
// These will be used throughout the components, but it's tidiest to keep the functions in one place
//

import useSWR from 'swr';

import {ClassName} from '../types';
import {API_ClassName_Pilots} from '../rest-api-types';

import {Icon} from './htmlhelper';

const fetcher = (url) => fetch(url).then((res) => res.json());

// How often to refresh the score or the track
const scoreRefreshInterval = process.env.NEXT_SCORE_REFRESH_INTERVAL ? process.env.NEXT_SCORE_REFRESH_INTERVAL : 60 * 1000;
const trackRefreshInterval = process.env.NEXT_TRACK_REFRESH_INTERVAL ? process.env.NEXT_TRACK_REFRESH_INTERVAL : 60 * 1000;

//
// Get name and details of the contest
export function useContest(initialData) {
    const {data, error} = useSWR('/api/contest', fetcher); //, {initialData});
    return {
        comp: data,
        isLoading: !error && !data,
        isError: !!error
    };
}

//
// Get the task details
export function useTask(vc: ClassName) {
    const {data, error} = useSWR(() => (vc ? '/api/' + vc + '/task' : null), fetcher);
    return {
        data: data,
        isLoading: !error && !data,
        isError: !!error
    };
}

//
// Get the GeoJSON representing the task, this includes sectors, tracklines and markers
export function useTaskGeoJSON(vc: ClassName) {
    const {data, error} = useSWR(() => '/api/' + vc + '/geoTask', fetcher);
    return {
        taskGeoJSON: data,
        isTLoading: !error && !data,
        isTError: !!error
    };
}

export function usePilots(vc: ClassName): {pilots: API_ClassName_Pilots; isPLoading: boolean; isPError: boolean} {
    const {data, error} = useSWR(() => '/api/' + vc + '/pilots', fetcher);
    return {
        pilots: data?.pilots,
        isPLoading: !error && !data,
        isPError: !!error
    };
}

//
// Loading helpers
export function Spinner() {
    return (
        <div>
            <Icon type="plane" spin={true} />
        </div>
    );
}

export function Error() {
    return <div>Oops!</div>;
}
