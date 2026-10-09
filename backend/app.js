const express = require('express');
const crypto = require('crypto');
const { createAuth } = require('./auth');
const { createLogger } = require('./logger');
const { requestContext, errorHandler } = require('./errors');
const helmet = require('helmet');
const { singleFileUpload } = require('./uploads');
const { createStorage, presignTtlFromEnv, sseFromEnv } = require('./storage');
const { corsAllowlist, limiter, DEFAULT_LIMITS, originsFromEnv } = require('./security');
const { healthHandler, chainChecks } = require('./health');

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

/**
 * Builds the API. `s3` is an S3Client (or anything with `send`), injected so
 * tests can prove which routes write to the bucket.
 *
 * Verification and issuance are separate routes on purpose:
 * - POST /api/hash   hashes in memory and stores NOTHING. Used to check a suspect file.
 * - POST /api/anchor hashes and stores in S3. Used by the issuing officer before the chain write. Requires login.
 * - POST /api/auth/login exchanges the issuer's credentials for a short-lived token.
 */
function createApp({
    s3, bucketName, region, auth: authConfig, logger = createLogger({ logDir: null }),
    corsOrigins = originsFromEnv(),            // exact origins allowed to call the API from a browser
    rateLimits = DEFAULT_LIMITS,
    health = {},                               // extra or replacement health checks: name -> async () => 'ok' | 'not_configured'
    trustProxy = false,                        // set to the proxy hop count when running behind a load balancer
    maxFileSizeMb,                             // upload size limit; defaults to MAX_FILE_SIZE_MB or 10
    sse = sseFromEnv(),                        // server-side encryption: { mode: 'AES256' | 'aws:kms', kmsKeyId }
    presignTtlSeconds = presignTtlFromEnv(),   // signed link lifetime, capped at 300 s
    presign,                                   // (command, ttl) => url; only replaced in tests
}) {
    // Fails closed: the app cannot be built without a valid auth configuration.
    const auth = createAuth(authConfig);
    const app = express();
    app.set('trust proxy', trustProxy);
    app.disable('x-powered-by');
    app.use(requestContext(logger));
    app.use(helmet());
    app.use(corsAllowlist(corsOrigins));
    app.use(express.json({ limit: '1mb' }));

    const storage = createStorage({ s3, bucketName, sse, presignTtlSeconds, presign });
    const fileLimit = limiter({ ...DEFAULT_LIMITS.files, ...rateLimits.files });
    const loginLimit = limiter({ ...DEFAULT_LIMITS.login, ...rateLimits.login });

    // File handling: size limit, type allowlist, magic-byte check and a sanitised name (see uploads.js)
    const uploadFile = singleFileUpload({ maxFileSizeMb });

    // --- ROUTE: Hash only (verification) ---
    // The suspect file never leaves this request: no S3 write, no disk write.
    app.post('/api/hash', fileLimit, ...uploadFile, (req, res) => {
        const file = req.file;
        if (!file) return res.status(400).send("No file.");
        res.json({ success: true, hash: sha256(file.buffer) });
    });

    // --- ROUTE: Issuer login ---
    app.post('/api/auth/login', loginLimit, async (req, res) => {
        const { username, password } = req.body || {};
        const token = await auth.login(username, password);
        if (!token) return res.status(401).json({ success: false, error: 'Invalid credentials.' });
        res.json({ success: true, token });
    });

    // --- ROUTE: Hash & store (issuance) ---
    // Issuers only: requires a valid bearer token.
    app.post('/api/anchor', fileLimit, auth.requireAuth, ...uploadFile, async (req, res, next) => {
        try {
            const file = req.file;
            if (!file) return res.status(400).send("No file.");

            // 1. SHA-256 of the content. It is also the S3 key.
            const hash = sha256(file.buffer);

            // 2. Store encrypted under that key (an identical file already there is left untouched)
            const { key, alreadyStored } = await storage.store({
                hash, buffer: file.buffer, contentType: file.detectedMime, originalName: file.safeName,
            });

            // 3. Hand back a short-lived signed link; the bucket itself is private
            const { url, expiresInSeconds } = await storage.signedUrl(key);

            res.json({
                success: true,
                hash,
                s3Key: key,
                url,
                urlExpiresInSeconds: expiresInSeconds,
                alreadyStored,
                message: alreadyStored ? "This exact file was already stored." : "File stored in AWS S3. Hash generated.",
            });

        } catch (err) {
            next(err);   // logged (redacted) and answered generically by errorHandler
        }
    });

    // --- ROUTE: Health (public, no secrets) ---
    app.get('/api/health', healthHandler({
        app: async () => 'ok',
        s3_config: async () => (bucketName && region ? 'ok' : 'not_configured'),   // config only: no S3 call
        mongodb: async () => 'not_configured',                                    // replaced when the database lands (#53)
        ...chainChecks(),
        ...health,
    }));

    app.use((req, res, next) => next(Object.assign(new Error('not found'), { status: 404 })));
    app.use(errorHandler(logger));

    return app;
}

module.exports = { createApp };
