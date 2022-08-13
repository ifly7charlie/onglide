//
//
// Helper functions for loading data from APIs
//
// These will be used throughout the components, but it's tidiest to keep the functions in one place
//

import useSWR from 'swr';

import {ClassName} from '../types';
import {API_ClassName_Pilots} from '../rest-api-types';

import {FontAwesomeIcon} from '@fortawesome/react-fontawesome';
import {faSpinner} from '@fortawesome/free-solid-svg-icons';

const fetcher = (url) => fetch(url).then((res): any => (res.status == 200 ? res.json() : {}));

// How often to refresh the score or the track
//
// Get name and details of the contest
export function useContest() {
    const {data, error}: {data?: any; error?: boolean} = useSWR('/api/contest', fetcher, {refreshInterval: 5 * 60 * 1000});
    return {
        comp: data,
        isLoading: !error && !data,
        isError: !!error
    };
}

//
// Get the task details
export function useTask(vc: ClassName) {
    const {data, error}: {data?: any; error?: boolean} = useSWR(() => (vc ? '/api/' + vc + '/task' : null), fetcher, {refreshInterval: 5 * 60 * 1000});
    return {
        data: data,
        isLoading: !error && !data,
        isError: !!error
    };
}

//
// Get the GeoJSON representing the task, this includes sectors, tracklines and markers
export function useTaskGeoJSON(vc: ClassName) {
    const {data, error}: {data?: any; error?: boolean} = useSWR(() => '/api/' + vc + '/geoTask', fetcher, {refreshInterval: 5 * 60 * 1000});
    return {
        taskGeoJSON: data,
        isTLoading: !error && !data,
        isTError: !!error
    };
}

export function usePilots(vc: ClassName): {pilots: API_ClassName_Pilots; isPLoading: boolean; isPError: boolean} {
    const {data, error}: {data?: any; error?: boolean} = useSWR(() => '/api/' + vc + '/pilots', fetcher, {refreshInterval: 10 * 60 * 1000});
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
            <FontAwesomeIcon icon={faSpinner} spin={true} />
        </div>
    );
}

export function Error() {
    return <div></div>;
}
