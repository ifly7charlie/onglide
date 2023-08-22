import {memo} from 'react';
import {FontAwesomeIcon} from '@fortawesome/react-fontawesome';
import {solid} from '@fortawesome/fontawesome-svg-core/import.macro';

import {getSortOrderType, getSortDescription, SortKey} from './pilot-sorting';

export const Sorting = memo(function Sorting(props: {setSort: Function; sortOrder: SortKey; toggleVisible: Function; visible: boolean; handicapped: boolean}) {
    return (
        <div style={{paddingBottom: '3px'}}>
            <span className="d-lg-inline d-none" id="sortdescription" style={{fontSize: 'small', maxWidth: '30%', width: '30%', display: 'inline-block'}}>
                {getSortDescription(props.sortOrder, props.handicapped)}
            </span>
            <span className="sorting">
                <button title="Sort Automatically" onClick={() => props.setSort('auto')} className={props.sortOrder == 'auto' ? 'active' : ''}>
                    <FontAwesomeIcon icon={solid('star')} />
                </button>
                <button title="Show Speed" onClick={() => props.setSort('speed')} className={getSortOrderType(props.sortOrder) == 'speed' ? 'active' : ''}>
                    <FontAwesomeIcon icon={solid('trophy')} />
                </button>
                <button title="Show Height" onClick={() => props.setSort('height')} className={getSortOrderType(props.sortOrder) == 'height' ? 'active' : ''}>
                    <FontAwesomeIcon icon={solid('cloud-upload')} />
                    &nbsp;
                </button>
                <button title="Show Current Climb Average" onClick={() => props.setSort('climb')} className={getSortOrderType(props.sortOrder) == 'climb' ? 'active' : ''}>
                    <FontAwesomeIcon icon={solid('upload')} />
                    &nbsp;
                </button>
                <button title="Show L/D Remaining" onClick={() => props.setSort('ld')} className={getSortOrderType(props.sortOrder) == 'ld' ? 'active' : ''}>
                    <FontAwesomeIcon icon={solid('fast-forward')} />
                    &nbsp;
                </button>
                <button title="Show Distance Done" onClick={() => props.setSort('distance')} className={getSortOrderType(props.sortOrder) == 'distance' ? 'active' : ''}>
                    <FontAwesomeIcon icon={solid('right-from-bracket')} />
                    &nbsp;
                </button>
                <button title="Show Distance Remaining" onClick={() => props.setSort('remaining')} className={getSortOrderType(props.sortOrder) == 'remaining' ? 'active' : ''}>
                    <FontAwesomeIcon icon={solid('right-to-bracket')} />
                    &nbsp;
                </button>
                <button title="Cycle through times" onClick={() => props.setSort('times')} className={getSortOrderType(props.sortOrder) == 'times' ? 'active' : ''}>
                    <FontAwesomeIcon icon={solid('stopwatch')} />
                    &nbsp;
                </button>
                &nbsp;
                <button className="d-lg-inline d-none" onClick={() => props.toggleVisible()} title={props.visible ? 'Hide Results' : 'Show Results'} aria-controls="task-collapse" aria-expanded={props.visible}>
                    <FontAwesomeIcon icon={solid('tasks')} />
                    <FontAwesomeIcon icon={props.visible ? solid('caret-up') : solid('caret-down')} />
                </button>
            </span>
        </div>
    );
});
