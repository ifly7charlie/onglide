import {ReactNode} from 'react';

import {FontAwesomeIcon} from '@fortawesome/react-fontawesome';
import {faGlobe} from '@fortawesome/free-solid-svg-icons';

import {Options} from './options';
import {classDisplayStatus, StatusIcon, STATUS_LABELS} from './competition-status';

import type {Options as OptionsType, ClassName} from '../types';

interface SidePanelProps {
    comp: any;
    vc: ClassName;
    onClassChange: (className: string) => void;
    options: OptionsType;
    setOptions: Function;
    head?: ReactNode;
    children?: ReactNode;
    footer?: ReactNode;
}

export function compShortName(comp: any) {
    return (
        comp?.competition?.name
            ?.replace(/.*Women's World Gliding Championship[s]*/gi, 'WWGC')
            .replace(/.*World Gliding Championship[s]*/gi, 'WGC')
            .replace(/.*European Gliding Championship[s]*/gi, 'EGC')
            .replace(/.*Sailplane Grandprix]*/gi, 'SGP')
            ?.trim() || comp?.competition?.name || ''
    );
}

export function SidePanelHeader({comp}: {comp: any}) {
    const shortName = compShortName(comp);
    return (
        <div className="sidepanel-header">
            <a href="/" className="sidepanel-back" title="Back to globe" aria-label="Back to globe">
                <FontAwesomeIcon icon={faGlobe} />
            </a>
            <div className="sidepanel-title">
                <div className="sidepanel-comp-name">
                    {comp?.competition?.mainwebsite ? (
                        <a href={comp.competition.mainwebsite} style={{color: 'inherit'}}>
                            {shortName}
                        </a>
                    ) : (
                        shortName
                    )}
                </div>
                {comp?.competition?.start && comp?.competition?.end ? (
                    <div className="sidepanel-comp-dates">
                        {comp.competition.start} → {comp.competition.end}
                    </div>
                ) : null}
            </div>
        </div>
    );
}

export function SidePanelClassTabs({comp, vc, onClassChange}: {comp: any; vc: ClassName; onClassChange: (className: string) => void}) {
    const multipleClasses = (comp?.classes?.length ?? 0) > 1;
    if (!multipleClasses) return null;
    // The user is viewing this competition, so it's effectively current —
    // pass inWindow=true so a class with status B/P maps to 'task_set'
    // rather than falling through to 'upcoming'.
    return (
        <div className="sidepanel-classes" role="tablist">
            {comp.classes.map((c: any) => {
                const ds = classDisplayStatus(c.status ?? '', true, false);
                return (
                    <button
                        key={c.class}
                        role="tab"
                        aria-selected={c.class === vc}
                        className={c.class === vc ? 'active' : ''}
                        title={STATUS_LABELS[ds]}
                        onClick={() => onClassChange(c.class)}
                    >
                        <StatusIcon status={ds} className="status-icon" />
                        {c.classname.replace(/\s+(meter|metre)/, 'm')}
                    </button>
                );
            })}
        </div>
    );
}

export function SidePanel({comp, vc, onClassChange, options, setOptions, head, children, footer}: SidePanelProps) {
    const multipleClasses = (comp?.classes?.length ?? 0) > 1;

    return (
        <aside className="sidepanel">
            <SidePanelHeader comp={comp} />
            <SidePanelClassTabs comp={comp} vc={vc} onClassChange={onClassChange} />

            <div className="sidepanel-tools">
                <Options options={options} setOptions={setOptions} multipleClasses={multipleClasses} />
            </div>

            {head ? <div className="sidepanel-fixed-head">{head}</div> : null}

            <div className="sidepanel-body">{children}</div>

            {footer ? <div className="sidepanel-footer">{footer}</div> : null}
        </aside>
    );
}
