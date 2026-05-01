export interface SupportedLanguage {
    code: string;
    label: string;
    // Unicode flag emoji for the country whose flag is most associated with
    // the language. `nb` (Norwegian Bokmål) maps to 🇳🇴, `en` to 🇬🇧 because
    // onglide originated in the UK gliding scene. These are not perfect
    // language→flag mappings (no country owns a language), but they're the
    // convention users recognise instantly in language pickers.
    flag: string;
}

export const supportedLanguages: SupportedLanguage[] = [
    {code: 'en', label: 'English', flag: '🇬🇧'},
    {code: 'de', label: 'Deutsch', flag: '🇩🇪'},
    {code: 'fr', label: 'Français', flag: '🇫🇷'},
    {code: 'nl', label: 'Nederlands', flag: '🇳🇱'},
    {code: 'es', label: 'Español', flag: '🇪🇸'},
    {code: 'it', label: 'Italiano', flag: '🇮🇹'},
    {code: 'pl', label: 'Polski', flag: '🇵🇱'},
    {code: 'cs', label: 'Čeština', flag: '🇨🇿'},
    {code: 'sk', label: 'Slovenčina', flag: '🇸🇰'},
    {code: 'hu', label: 'Magyar', flag: '🇭🇺'},
    {code: 'sv', label: 'Svenska', flag: '🇸🇪'},
    {code: 'da', label: 'Dansk', flag: '🇩🇰'},
    {code: 'fi', label: 'Suomi', flag: '🇫🇮'},
    {code: 'sl', label: 'Slovenščina', flag: '🇸🇮'},
    {code: 'nb', label: 'Norsk Bokmål', flag: '🇳🇴'}
];

export const supportedLocales = supportedLanguages.map((l) => l.code);
export const defaultLocale = 'en';
