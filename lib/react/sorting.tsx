import {memo, useState, useRef, useEffect, useCallback} from 'react';
import {FontAwesomeIcon} from '@fortawesome/react-fontawesome';

import {
    faBatteryThreeQuarters,
    faCaretDown,
    faCloudUpload,
    faRightFromBracket,
    faRightToBracket,
    faStar,
    faStopwatch,
    faTrophy,
    faUpload
} from '@fortawesome/free-solid-svg-icons';

import {getSortOrderType, getSortDescription, shortLabels, handicappedSortOrders, nonHandicappedSortOrders} from './pilot-sorting';
import {SortKey} from '../types';

const sortGroups = [
    {key: 'auto', icon: faStar, label: 'Auto'},
    {key: 'speed', icon: faTrophy, label: 'Speed'},
    {key: 'height', icon: faCloudUpload, label: 'Height'},
    {key: 'climb', icon: faUpload, label: 'Climb'},
    {key: 'ld', icon: faBatteryThreeQuarters, label: 'L/D'},
    {key: 'distance', icon: faRightFromBracket, label: 'Dist Done'},
    {key: 'remaining', icon: faRightToBracket, label: 'Dist Rem'},
    {key: 'times', icon: faStopwatch, label: 'Times'}
] as const;

export const Sorting = memo(function Sorting(props: {setSort: Function; sortOrder: SortKey; handicapped: boolean}) {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    const close = useCallback(() => setOpen(false), []);

    useEffect(() => {
        if (!open) return;
        const handler = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) {
                close();
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [open, close]);

    const orders = props.handicapped ? handicappedSortOrders : nonHandicappedSortOrders;
    const currentType = getSortOrderType(props.sortOrder);
    const currentOption = sortGroups.find((o) => o.key === currentType) ?? sortGroups[0];
    const description = getSortDescription(props.sortOrder, props.handicapped);

    return (
        <div className="sort-dropdown" ref={ref}>
            <button className="sort-trigger" onClick={() => setOpen(!open)}>
                <FontAwesomeIcon icon={currentOption.icon} />
                <span className="sort-label">{description}</span>
                <FontAwesomeIcon icon={faCaretDown} className={open ? 'sort-caret open' : 'sort-caret'} />
            </button>
            {open ? (
                <div className="sort-menu">
                    {sortGroups.map((group) => {
                        const subKeys = orders[group.key] ?? [];
                        return (
                            <div key={group.key} className="sort-row">
                                <span className="sort-row-label">
                                    <FontAwesomeIcon icon={group.icon} />
                                    <span>{group.label}</span>
                                </span>
                                <span className="sort-row-options">
                                    {subKeys.map((sk) => (
                                        <button
                                            key={sk}
                                            className={props.sortOrder === sk ? 'active' : ''}
                                            title={getSortDescription(sk, props.handicapped)}
                                            onClick={() => {
                                                props.setSort(sk);
                                                setOpen(false);
                                            }}
                                        >
                                            {shortLabels[sk] ?? sk}
                                        </button>
                                    ))}
                                </span>
                            </div>
                        );
                    })}
                </div>
            ) : null}
        </div>
    );
});
