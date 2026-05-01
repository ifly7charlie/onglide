import {memo, useState, useRef, useEffect, useCallback} from 'react';
import {useTranslation} from 'next-i18next/pages';
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

import {getSortOrderType, getSortDescription, getShortLabel, handicappedSortOrders, nonHandicappedSortOrders} from './pilot-sorting';
import {SortKey} from '../types';

// Each group binds a UI bucket to a translation key under `pilot_metric.*`
// in common.json. The translated text is rendered via t(labelKey).
const sortGroups = [
    {key: 'auto', icon: faStar, labelKey: 'pilot_metric.auto'},
    {key: 'speed', icon: faTrophy, labelKey: 'pilot_metric.speed'},
    {key: 'height', icon: faCloudUpload, labelKey: 'pilot_metric.height'},
    {key: 'climb', icon: faUpload, labelKey: 'pilot_metric.climb'},
    {key: 'ld', icon: faBatteryThreeQuarters, labelKey: 'pilot_metric.ld'},
    {key: 'distance', icon: faRightFromBracket, labelKey: 'pilot_metric.dist_done'},
    {key: 'remaining', icon: faRightToBracket, labelKey: 'pilot_metric.dist_rem'},
    {key: 'times', icon: faStopwatch, labelKey: 'pilot_metric.times'}
] as const;

export const Sorting = memo(function Sorting(props: {setSort: Function; sortOrder: SortKey; handicapped: boolean}) {
    const {t} = useTranslation('common');
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
    const descriptionKey = getSortDescription(props.sortOrder, props.handicapped);

    return (
        <div className="sort-dropdown" ref={ref}>
            <button className="sort-trigger" onClick={() => setOpen(!open)}>
                <FontAwesomeIcon icon={currentOption.icon} />
                <span className="sort-label">{descriptionKey ? t(descriptionKey) : ''}</span>
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
                                    <span>{t(group.labelKey)}</span>
                                </span>
                                <span className="sort-row-options">
                                    {subKeys.map((sk) => {
                                        const titleKey = getSortDescription(sk, props.handicapped);
                                        const labelKey = getShortLabel(sk);
                                        return (
                                            <button
                                                key={sk}
                                                className={props.sortOrder === sk ? 'active' : ''}
                                                title={titleKey ? t(titleKey) : ''}
                                                onClick={() => {
                                                    props.setSort(sk);
                                                    setOpen(false);
                                                }}
                                            >
                                                {labelKey ? t(labelKey) : sk}
                                            </button>
                                        );
                                    })}
                                </span>
                            </div>
                        );
                    })}
                </div>
            ) : null}
        </div>
    );
});
