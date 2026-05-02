import {useTranslation} from 'next-i18next/pages';

const REPO_URL = 'https://github.com/ifly7charlie/onglide';

export function TranslationHelpFooter() {
    const {t} = useTranslation('common');
    return (
        <div className="translation-help-footer" style={{textAlign: 'center', fontSize: '0.7rem', opacity: 0.65, padding: '2px 4px'}}>
            <a href={REPO_URL} target="_blank" rel="noreferrer noopener">
                {t('footer.translation_help_link_label')}
            </a>
        </div>
    );
}
