import {useCallback, useEffect, useRef, useState} from 'react';
import {useRouter} from 'next/router';
import {useTranslation} from 'next-i18next/pages';
import {FontAwesomeIcon} from '@fortawesome/react-fontawesome';
import {faCaretDown} from '@fortawesome/free-solid-svg-icons';

import {supportedLanguages} from '../i18n/languages';

// Language picker styled to match the Sort dropdown (trigger button + absolute
// popover menu, click-outside closes). Trigger shows only the current locale's
// flag emoji; menu rows show flag + native language label.
export function LanguageSwitcher({className}: {className?: string} = {}) {
    const router = useRouter();
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

    const current = supportedLanguages.find((l) => l.code === router.locale) ?? supportedLanguages[0];

    const onPick = useCallback(
        (code: string) => {
            setOpen(false);
            if (code === router.locale) return;
            router.push(router.asPath, router.asPath, {locale: code});
        },
        [router]
    );

    return (
        <div className={className ? `language-switcher ${className}` : 'language-switcher'} ref={ref}>
            <button //
                className="lang-trigger"
                onClick={() => setOpen((o) => !o)}
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-label={t('app.language')}
                title={t('app.language')}
            >
                <span className="lang-trigger-flag">{current.flag}</span>
                <FontAwesomeIcon icon={faCaretDown} className={open ? 'lang-caret open' : 'lang-caret'} />
            </button>
            {open ? (
                <div className="lang-menu" role="listbox">
                    {supportedLanguages.map((l) => (
                        <button //
                            key={l.code}
                            role="option"
                            aria-selected={l.code === router.locale}
                            className={l.code === router.locale ? 'lang-row active' : 'lang-row'}
                            onClick={() => onPick(l.code)}
                        >
                            <span className="lang-row-flag">{l.flag}</span>
                            <span className="lang-row-label">{l.label}</span>
                        </button>
                    ))}
                </div>
            ) : null}
        </div>
    );
}
