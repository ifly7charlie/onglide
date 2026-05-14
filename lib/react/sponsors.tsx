import {useMemo} from 'react';
import {useTranslation} from 'next-i18next/pages';

import {TranslationHelpFooter} from './translation-help-footer';
import {LanguageSwitcher} from './language-switcher';
import {OptionalDurationMM} from './optional';
import type {Epoch, TZ} from '../types';

const OGN_LOGO = (
    <a href="http://www.glidernet.org/" title="OGN Network" target="_blank" rel="noreferrer">
        <img width="50" height="34" src="/ognlogo.png" alt="OGN Network" />
    </a>
);

interface WsStatus {
    listeners: number;
    airborne: number;
    at: Epoch;
}

interface SponsorProps {
    wsStatus?: WsStatus;
    tz: TZ;
    lang: string;
    officialDelay: number;
}

export default function Sponsor({wsStatus, tz, lang, officialDelay}: SponsorProps) {
    const {t} = useTranslation('common');

    const timeRow = useMemo(() => {
        if (!wsStatus?.at) return null;
        const showDelay = officialDelay > 10;
        const dt = new Date(wsStatus.at * 1000);
        const dtl = !showDelay ? dt : new Date((wsStatus.at + officialDelay) * 1000);
        const compTime = dt.toLocaleTimeString(lang, {timeZone: tz, hour: '2-digit', minute: '2-digit'});
        const yourTime = dtl.toLocaleTimeString(lang, {hour: '2-digit', minute: '2-digit'});
        const showYourTime = yourTime !== compTime;
        const delayLabel = showDelay ? OptionalDurationMM('', officialDelay as Epoch, 'm') : '';
        return (
            <div className="sponsor-status-row sponsor-status-grid">
                <span className="sponsor-cell-left">
                    {t('connection.updated_at', {time: compTime})}
                    {showDelay ? (
                        <span style={{color: 'grey'}} title="Tracking is officially delayed for this competition">
                            &nbsp;+&nbsp;↺&nbsp;{delayLabel}
                        </span>
                    ) : null}
                    &nbsp;✈️
                </span>
                <span className="sponsor-cell-center" />
                <span className="sponsor-cell-right">{showYourTime ? `${yourTime} ⌚️` : ''}</span>
            </div>
        );
    }, [wsStatus?.at, tz, lang, officialDelay, t]);

    return (
        <div className="sponsor">
            <div className="sponsor-row">
                <div className="sponsor-logo">{OGN_LOGO}</div>
                <div className="sponsor-status">
                    {timeRow}
                    <div className="sponsor-status-row sponsor-status-grid">
                        <span className="sponsor-cell-left" title={t('connection.viewers')}>
                            {wsStatus?.listeners ?? 0} 👥
                        </span>
                        <span className="sponsor-cell-center" title={t('connection.tracked_planes')}>
                            {wsStatus?.airborne ?? 0} ✈️
                        </span>
                        <span className="sponsor-cell-right sponsor-cell-info-lang">
                            <TranslationHelpFooter />
                            <LanguageSwitcher className="sponsor-lang" />
                        </span>
                    </div>
                </div>
            </div>
        </div>
    );
}
