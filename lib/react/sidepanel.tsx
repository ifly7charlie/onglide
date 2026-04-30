import {ReactNode} from 'react';
import Link from 'next/link';
import {useTranslation} from 'next-i18next/pages';

import {FontAwesomeIcon} from '@fortawesome/react-fontawesome';
import {faGlobe} from '@fortawesome/free-solid-svg-icons';

import {Options} from './options';
import {LanguageSwitcher} from './language-switcher';
import {StatusIcon, STATUS_LABEL_KEYS} from './competition-status';
import type {CompetitionDisplayStatus} from '../competition-display-status';

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
        comp?.name
            ?.replace(/.*Women's World Gliding Championship[s]*/gi, 'WWGC')
            .replace(/.*World Gliding Championship[s]*/gi, 'WGC')
            .replace(/.*European Gliding Championship[s]*/gi, 'EGC')
            .replace(/.*Sailplane Grandprix]*/gi, 'SGP')
            ?.trim() || comp?.name || ''
    );
}

export function SidePanelHeader({comp}: {comp: any}) {
    const {t} = useTranslation('common');
    const shortName = compShortName(comp);
    return (
        <div className="sidepanel-header">
            <Link href="/" className="sidepanel-back" title={t('app.back_to_globe')} aria-label={t('app.back_to_globe')}>
                <FontAwesomeIcon icon={faGlobe} />
            </Link>
            <div className="sidepanel-title">
                <div className="sidepanel-comp-name">
                    {comp?.mainwebsite ? (
                        <a href={comp.mainwebsite} style={{color: 'inherit'}}>
                            {shortName}
                        </a>
                    ) : (
                        shortName
                    )}
                </div>
                {comp?.start && comp?.end ? (
                    <div className="sidepanel-comp-dates">
                        {comp.start} → {comp.end}
                    </div>
                ) : null}
            </div>
            <LanguageSwitcher className="sidepanel-header-lang" />
        </div>
    );
}

export function SidePanelClassTabs({comp, vc, onClassChange}: {comp: any; vc: ClassName; onClassChange: (className: string) => void}) {
    const {t} = useTranslation('common');
    const multipleClasses = (comp?.classes?.length ?? 0) > 1;
    if (!multipleClasses) return null;
    return (
        <div className="sidepanel-classes" role="tablist">
            {comp.classes.map((c: any) => {
                // displayStatus is computed by the daemon (bin/ogn.ts:buildCompetitionSummary)
                // with proper datecode-staleness demotion; trust it as-is.
                const ds = (c.displayStatus ?? 'notask') as CompetitionDisplayStatus;
                return (
                    <button
                        key={c.class}
                        role="tab"
                        aria-selected={c.class === vc}
                        className={c.class === vc ? 'active' : ''}
                        title={t(STATUS_LABEL_KEYS[ds])}
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
