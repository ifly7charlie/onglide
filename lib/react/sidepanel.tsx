import {ReactNode} from 'react';

import {FontAwesomeIcon} from '@fortawesome/react-fontawesome';
import {faGlobe} from '@fortawesome/free-solid-svg-icons';

import {Options} from './options';

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

export function SidePanel({comp, vc, onClassChange, options, setOptions, head, children, footer}: SidePanelProps) {
    const multipleClasses = (comp?.classes?.length ?? 0) > 1;

    const shortNameBase = (
        comp?.competition?.name
            ?.replace(/.*Women's World Gliding Championship[s]*/gi, 'WWGC')
            .replace(/.*World Gliding Championship[s]*/gi, 'WGC')
            .replace(/.*European Gliding Championship[s]*/gi, 'EGC')
            .replace(/.*Sailplane Grandprix]*/gi, 'SGP')
            ?.trim() || comp?.competition?.name || ''
    ).substring(0, 28);
    const shortName = shortNameBase + (shortNameBase.length === 28 ? '…' : '');

    return (
        <aside className="sidepanel">
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

            {multipleClasses ? (
                <div className="sidepanel-classes" role="tablist">
                    {comp.classes.map((c: any) => (
                        <button
                            key={c.class}
                            role="tab"
                            aria-selected={c.class === vc}
                            className={c.class === vc ? 'active' : ''}
                            onClick={() => onClassChange(c.class)}
                        >
                            {c.classname.replace(/\s+(meter|metre)/, 'm')}
                        </button>
                    ))}
                </div>
            ) : null}

            <div className="sidepanel-tools">
                <Options options={options} setOptions={setOptions} multipleClasses={multipleClasses} />
            </div>

            {head ? <div className="sidepanel-fixed-head">{head}</div> : null}

            <div className="sidepanel-body">{children}</div>

            {footer ? <div className="sidepanel-footer">{footer}</div> : null}
        </aside>
    );
}
