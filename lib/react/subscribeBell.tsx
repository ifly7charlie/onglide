import useSWR from 'swr';
import {useTranslation} from 'next-i18next/pages';

import {FontAwesomeIcon} from '@fortawesome/react-fontawesome';
import {faBell, faBellSlash} from '@fortawesome/free-solid-svg-icons';

import {usePushSubscription} from './usePushSubscription';

// Gate to the right of the competition name: the subscribe bell only appears
// for competitions that have opted in to push notifications
// (competition.pushnotifications = 'Y', reported by /api/push/enabled). Only
// when enabled does SubscribeBellButton mount and run the push hooks.
export function SubscribeBell({compid}: {compid: string | undefined}) {
    const {data} = useSWR(compid ? '/api/push/enabled?compid=' + compid : null, (url: string) => fetch(url).then((r) => (r.ok ? r.json() : {enabled: false})));
    if (!compid || data?.enabled !== true) return null;
    return <SubscribeBellButton compid={compid} />;
}

// The bell itself — subscribes this browser to Web Push notifications for the
// competition's status changes. Renders nothing when the browser can't do
// push. State is backend-authoritative (see usePushSubscription).
function SubscribeBellButton({compid}: {compid: string}) {
    const {t, i18n} = useTranslation('common');
    // Base language (e.g. 'de' from 'de-DE') — stored so the daemon renders
    // notification text in the subscriber's language.
    const lang = (i18n?.language || 'en').split('-')[0];
    const {supported, subscribed, loading, busy, denied, subscribe, unsubscribe} = usePushSubscription(compid, lang);
    // Hide entirely until we know push is usable AND we've resolved the
    // current subscription state — no flash of a disabled bell on first paint.
    if (!supported || loading) return null;
    const label = denied ? t('competition.notify_denied') : subscribed ? t('competition.notify_unsubscribe') : t('competition.notify_subscribe');
    // The bell is gated only on an in-flight subscribe/unsubscribe or an OS-level
    // permission block — never on the status query, so it can't get stuck.
    return (
        <button
            type="button"
            className={'sidepanel-bell' + (subscribed ? ' subscribed' : '')}
            title={label}
            aria-label={label}
            aria-pressed={subscribed}
            disabled={busy || denied}
            onClick={subscribed ? unsubscribe : subscribe}
        >
            <FontAwesomeIcon icon={subscribed ? faBell : faBellSlash} />
        </button>
    );
}
