/** @type {import('next-i18next').UserConfig} */
// Omitting `localeDetection` keeps Next.js's built-in default (true), which
// performs Accept-Language–based detection on the first request and persists
// the choice via the NEXT_LOCALE cookie. Setting it explicitly to `true`
// triggers a config schema warning in Next 16, so we just leave it off.
module.exports = {
    i18n: {
        defaultLocale: 'en',
        locales: ['en', 'de', 'fr', 'nl', 'es', 'it', 'pl', 'cs', 'sk', 'hu', 'sv', 'da', 'fi', 'sl', 'nb']
    },
    transSupportBasicHtmlNodes: true,
    reloadOnPrerender: process.env.NODE_ENV === 'development'
};
