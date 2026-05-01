const {i18n} = require('./next-i18next.config');

module.exports = (phase, {defaultConfig}) => {
    /**
     * @type {import('next').NextConfig}
     */
	const additionalconfig = process.env.SHORT_NAME ? {
        distDir: '.build' + (process.env.SHORT_NAME ?? '')
	} : {};


    const nextConfig = {
		...additionalconfig,
        /* config options here */
        allowedDevOrigins: ['viewer.onglide.com'],
        i18n,
    };
    return nextConfig;
};
