// HTTP hardening: CORS allowlist, rate limits, graceful shutdown.
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const DEV_ORIGINS = ['http://localhost:5173', 'http://localhost:4173'];   // vite dev and preview

/** "https://a.com, https://b.com" -> ['https://a.com', 'https://b.com'] */
function parseOrigins(value) {
    return String(value || '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
}

/** Allowlist from CORS_ORIGINS. Unset means local dev origins outside production, and nothing in production. */
function originsFromEnv(env = process.env) {
    if (env.CORS_ORIGINS !== undefined && env.CORS_ORIGINS.trim() !== '') return parseOrigins(env.CORS_ORIGINS);
    return env.NODE_ENV === 'production' ? [] : DEV_ORIGINS;
}

/**
 * Browser requests carry an Origin header. One that is not on the list gets 403 (not just missing CORS headers),
 * so a disallowed site cannot even cause a side effect. Requests with no Origin (curl, servers) pass through.
 */
function corsAllowlist(allowed) {
    const headers = cors({ origin: allowed, methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Authorization', 'Content-Type'], maxAge: 600 });
    return (req, res, next) => {
        const origin = req.headers.origin;
        if (origin && !allowed.includes(origin)) return next(Object.assign(new Error('origin not allowed'), { status: 403 }));
        headers(req, res, next);
    };
}

function limiter({ windowMs, limit }) {
    return rateLimit({
        windowMs, limit, standardHeaders: 'draft-7', legacyHeaders: false,
        handler: (req, res, next) => next(Object.assign(new Error('rate limit exceeded'), { status: 429 })),
    });
}

const DEFAULT_LIMITS = {
    files: { windowMs: 60 * 1000, limit: 30 },        // /api/hash and /api/anchor: hashing is CPU-bound
    login: { windowMs: 15 * 60 * 1000, limit: 10 },   // slows password guessing
    verify: { windowMs: 60 * 1000, limit: 10 },       // public verification runs OCR and image analysis: far heavier than hashing
};

/** Stops accepting connections on SIGTERM/SIGINT, lets in-flight requests finish, and exits (forced after a timeout). */
function installGracefulShutdown(server, logger, { timeoutMs = 10000, exit = process.exit, signals = ['SIGTERM', 'SIGINT'] } = {}) {
    let closing = false;
    const handler = (signal) => {
        if (closing) return;
        closing = true;
        logger.info('shutting down', { signal });
        const timer = setTimeout(() => { logger.error('forced shutdown after timeout'); exit(1); }, timeoutMs);
        timer.unref();
        server.close((err) => { clearTimeout(timer); exit(err ? 1 : 0); });
        if (server.closeIdleConnections) server.closeIdleConnections();
    };
    signals.forEach((s) => process.on(s, () => handler(s)));
    return handler;
}

module.exports = { parseOrigins, originsFromEnv, corsAllowlist, limiter, DEFAULT_LIMITS, installGracefulShutdown, DEV_ORIGINS };
