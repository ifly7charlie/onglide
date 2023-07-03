module.exports = (phase, {defaultConfig}) => {
    /**
     * @type {import('next').NextConfig}
     */
    console.log('Next config' + process.env.SHORT_NAME);
    const nextConfig = {
        /* config options here */
        distDir: ".build"+process.env.SHORT_NAME,
        i18n: {
            // These are all the locales you want to support in
            // your application
            locales: ['en-GB'],
            // This is the default locale you want to be used when visiting
            // a non-locale prefixed path e.g. `/hello`
            defaultLocale: 'en-GB'
        }
    };
    return nextConfig;
};
