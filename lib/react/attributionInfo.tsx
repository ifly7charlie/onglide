import {useState} from 'react';
import {useTranslation} from 'next-i18next/pages';

import {SATELLITE_ATTRIBUTION} from './mapStyle';

// Compact attribution: a small (i) trigger that opens a full-page opaque
// modal listing tile/data attributions. Replaces maplibre's built-in
// AttributionControl which expanded into a multi-line strip that overlapped
// the bottom-left map controls on narrow viewports.
const STATIC_ATTRIBUTIONS = [
    '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
    SATELLITE_ATTRIBUTION,
    'Elevation: AWS Open Data — USGS, NASA, CGIAR, NRCan, GEBCO, EU-DEM'
];

export function AttributionInfo({customParts}: {customParts: (string | undefined | null | false)[]}) {
    const {t} = useTranslation('common');
    const [open, setOpen] = useState(false);
    const items = [...STATIC_ATTRIBUTIONS, ...customParts.filter((p): p is string => Boolean(p))];

    return (
        <>
            <button //
                className="attribution-info-toggle"
                onClick={() => setOpen(true)}
                aria-label={t('options.map_attribution')}
                title={t('options.map_attribution')}
                type="button"
            >
                i
            </button>
            {open ? (
                <div className="attribution-info-modal" role="dialog" aria-modal="true" onClick={() => setOpen(false)}>
                    <div className="attribution-info-content" onClick={(e) => e.stopPropagation()}>
                        <button //
                            className="attribution-info-close"
                            onClick={() => setOpen(false)}
                            aria-label={t('options.close')}
                            type="button"
                        >
                            ×
                        </button>
                        {items.map((html, i) => (
                            <div key={i} className="attribution-info-line" dangerouslySetInnerHTML={{__html: html}} />
                        ))}
                    </div>
                </div>
            ) : null}
        </>
    );
}
