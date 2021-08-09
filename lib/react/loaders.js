//
//
// Helper functions for loading data from APIs
//
// These will be used throughout the components, but it's tidiest to keep the functions in one place
//

import useSWR from 'swr'
import next from 'next'

import { Icon } from './htmlhelper.js';

const fetcher = url => fetch(url).then(res => res.json());

// How often to refresh the score or the track
const scoreRefreshInterval = process.env.NEXT_SCORE_REFRESH_INTERVAL ? process.env.NEXT_SCORE_REFRESH_INTERVAL : (60*1000);
const trackRefreshInterval = process.env.NEXT_TRACK_REFRESH_INTERVAL ? process.env.NEXT_TRACK_REFRESH_INTERVAL : (60*1000);

//
// Get name and details of the contest
export function useContest (initialData) {
    const { data, error } = useSWR('/api/contest', fetcher, { initialData: initialData })
    return {
        comp: data,
        isLoading: !error && !data,
        isError: !!error
    }
}

//
// Get the task details
export function useTask (vc) {
    const { data, error } = useSWR( () => vc ? '/api/'+vc+'/task' : null, fetcher );
    return {
        data: data,
        isLoading: !error && !data,
        isError: !!error
    }
}

//
// Get the GeoJSON representing the task, this includes sectors, tracklines and markers
export function useTaskGeoJSON (vc) {
    const { data, error } = useSWR( () => '/api/'+vc+'/geoTask', fetcher );
    return {
        taskGeoJSON: data,
        isTLoading: !error && !data,
        isTError: !!error
    }
}

//
// Loading helpers
export function Spinner () {
    return <div><Icon type="plane" spin={true}/></div>;
}

export function Error () {
    return <div>Oops!</div>
}
