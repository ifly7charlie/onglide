import {ComponentType} from 'react';
import useSWR from 'swr';
import {useTranslation} from 'next-i18next/pages';

import {FontAwesomeIcon} from '@fortawesome/react-fontawesome';
import {faBell, faBellSlash} from '@fortawesome/free-solid-svg-icons';

import {usePushSubscription} from './usePushSubscription';

// Gate the bell on the competition having opted in to push notifications
// (competition.pushnotifications = 'Y', reported by /api/push/enabled). Only
// when enabled does the inner button mount and run the push hooks.
function SubscribeBellGate({compid, render: Inner}: {compid: string | undefined; render: ComponentType<{compid: string}>}) {
    const {data} = useSWR(compid ? '/api/push/enabled?compid=' + compid : null, (url: string) => fetch(url).then((r) => (r.ok ? r.json() : {enabled: false})));
    if (!compid || data?.enabled !== true) return null;
    return <Inner compid={compid} />;
}

// Shared hook state for both bell render variants — kept here so the gate
// can pick a renderer without each one re-implementing the hook plumbing.
function useBellState(compid: string) {
    const {t, i18n} = useTranslation('common');
    // Base language (e.g. 'de' from 'de-DE') — stored so the daemon renders
    // notification text in the subscriber's language.
    const lang = (i18n?.language || 'en').split('-')[0];
    const {supported, subscribed, loading, busy, denied, subscribe, unsubscribe} = usePushSubscription(compid, lang);
    const label = denied ? t('competition.notify_denied') : subscribed ? t('competition.notify_unsubscribe') : t('competition.notify_subscribe');
    return {supported, subscribed, loading, busy, denied, label, onClick: subscribed ? unsubscribe : subscribe};
}

// Icon-only bell — used in the desktop sidepanel header next to the comp name.
// Renders nothing when the browser can't do push or while subscription state
// is still loading, so it never flashes in as a disabled icon.
function SubscribeBellIcon({compid}: {compid: string}) {
    const {supported, subscribed, loading, busy, denied, label, onClick} = useBellState(compid);
    if (!supported || loading) return null;
    return (
        <button
            type="button"
            className={'sidepanel-bell' + (subscribed ? ' subscribed' : '')}
            title={label}
            aria-label={label}
            aria-pressed={subscribed}
            disabled={busy || denied}
            onClick={onClick}
        >
            <FontAwesomeIcon icon={subscribed ? faBell : faBellSlash} />
        </button>
    );
}

// Labeled row — used inside the mobile drawer where icon-only would be too
// terse and there's room for the full action text. Owns its drawer-group
// wrapper so an absent bell leaves no empty section behind. The inner
// .drawer-button-row absorbs the drawer-group's child padding so the bell
// button itself can keep the same padding/border as the class-tab buttons.
function SubscribeBellRow({compid}: {compid: string}) {
    const {supported, subscribed, loading, busy, denied, label, onClick} = useBellState(compid);
    if (!supported || loading) return null;
    return (
        <div className="drawer-group">
            <div className="drawer-button-row">
                <button
                    type="button"
                    className={'sidepanel-bell-row' + (subscribed ? ' subscribed' : '')}
                    aria-pressed={subscribed}
                    disabled={busy || denied}
                    onClick={onClick}
                >
                    <FontAwesomeIcon icon={subscribed ? faBell : faBellSlash} />
                    <span>{label}</span>
                </button>
            </div>
        </div>
    );
}

export const SubscribeBell = ({compid}: {compid: string | undefined}) => <SubscribeBellGate compid={compid} render={SubscribeBellIcon} />;
export const SubscribeBellMenuItem = ({compid}: {compid: string | undefined}) => <SubscribeBellGate compid={compid} render={SubscribeBellRow} />;
