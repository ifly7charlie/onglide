import {memo} from 'react';
import {FontAwesomeIcon} from '@fortawesome/react-fontawesome';

import {
    //
    faBatteryThreeQuarters,
    faCloudUpload,
    faRightFromBracket,
    faRightToBracket,
    faStar,
    faStopwatch,
    faTrophy,
    faUpload
} from '@fortawesome/free-solid-svg-icons';

import {getSortOrderType, getSortDescription} from './pilot-sorting';
import {SortKey} from '../types';

export const Sorting = memo(function Sorting(props: {setSort: Function; sortOrder: SortKey; handicapped: boolean}) {
    return (
        <div style={{paddingBottom: '3px'}}>
            <span id="sortdescription" style={{fontSize: 'small', maxWidth: '30%', width: '30%', display: 'inline-block'}}>
                {getSortDescription(props.sortOrder, props.handicapped)}
            </span>
            <span className="sorting">
                <button title="Sort Automatically" onClick={() => props.setSort('auto')} className={props.sortOrder == 'auto' ? 'active' : ''}>
                    <FontAwesomeIcon icon={faStar} />
                </button>
                <button title="Show Speed" onClick={() => props.setSort('speed')} className={getSortOrderType(props.sortOrder) == 'speed' ? 'active' : ''}>
                    <FontAwesomeIcon icon={faTrophy} />
                </button>
                <button title="Show Height" onClick={() => props.setSort('height')} className={getSortOrderType(props.sortOrder) == 'height' ? 'active' : ''}>
                    <FontAwesomeIcon icon={faCloudUpload} />
                </button>
                <button title="Show Current Climb Average" onClick={() => props.setSort('climb')} className={getSortOrderType(props.sortOrder) == 'climb' ? 'active' : ''}>
                    <FontAwesomeIcon icon={faUpload} />
                </button>
                <button title="Show L/D Remaining" onClick={() => props.setSort('ld')} className={getSortOrderType(props.sortOrder) == 'ld' ? 'active' : ''}>
                    <FontAwesomeIcon icon={faBatteryThreeQuarters} />
                </button>
                <button title="Show Distance Done" onClick={() => props.setSort('distance')} className={getSortOrderType(props.sortOrder) == 'distance' ? 'active' : ''}>
                    <FontAwesomeIcon icon={faRightFromBracket} />
                </button>
                <button title="Show Distance Remaining" onClick={() => props.setSort('remaining')} className={getSortOrderType(props.sortOrder) == 'remaining' ? 'active' : ''}>
                    <FontAwesomeIcon icon={faRightToBracket} />
                </button>
                <button title="Cycle through times" onClick={() => props.setSort('times')} className={getSortOrderType(props.sortOrder) == 'times' ? 'active' : ''}>
                    <FontAwesomeIcon icon={faStopwatch} />
                </button>
            </span>
        </div>
    );
});
