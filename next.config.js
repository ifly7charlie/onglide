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
    };
    return nextConfig;
};
