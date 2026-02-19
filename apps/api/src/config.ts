export const config = {
    get isProd() { return process.env.NODE_ENV === 'production'; },
    get port() { return Number(process.env.PORT) || 3000; },
    db: {
        get host() { return process.env.DB_HOST || 'localhost'; },
        get port() { return parseInt(process.env.DB_PORT || '5433'); },
        get user() { return process.env.DB_USER || 'user'; },
        get pass() { return process.env.DB_PASS || 'password'; },
        get name() { return process.env.DB_NAME || 'ozzserve'; },
    },
    stripe: {
        get webhookSecret() { return process.env.STRIPE_WEBHOOK_SECRET; },
        get secretKey() { return process.env.STRIPE_SECRET_KEY; },
    },
};

/**
 * Validates critical environment variables for production.
 * Throws an error if any required configuration is missing in production mode.
 */
export function validateConfig() {
    if (config.isProd) {
        if (!config.stripe.webhookSecret) {
            throw new Error('FATAL: STRIPE_WEBHOOK_SECRET is not set in production.');
        }
        // Add other critical production checks here
    }
}
