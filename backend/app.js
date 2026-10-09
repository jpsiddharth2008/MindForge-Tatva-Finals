const express = require('express');
const crypto = require('crypto');
const { createAuth } = require('./auth');
const { createLogger } = require('./logger');
const { requestContext, errorHandler } = require('./errors');
const helmet = require('helmet');
const { singleFileUpload } = require('./uploads');
const { createStorage, presignTtlFromEnv, sseFromEnv } = require('./storage');
const { publicView } = require('./documents');
const { createIssuance } = require('./issuance');
const { createChain } = require('./chain');
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
    documents,                                 // document records (documents.js). Without it, nothing is recorded.
    chainId,                                   // recorded on each document
    contractAddress,
    chain = process.env.RPC_URL ? createChain({ rpcUrl: process.env.RPC_URL }) : null,   // read-only chain access; confirms transactions
    issuanceOptions = {},                      // staleMs / stuckMs / now, for tests
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
    const issuance = documents ? createIssuance({ documents, storage, chain, chainId, contractAddress, ...issuanceOptions }) : null;
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

            // 2a. With a database: the record is claimed (PENDING) before the upload, an identical file is never issued
            //     twice, and every step leaves the record in a state that can be recovered (see issuance.js).
            if (issuance) {
                const r = await issuance.issue({
                    hash, buffer: file.buffer, contentType: file.detectedMime, originalName: file.safeName,
                    size: file.size, issuerName: req.user.sub,
                });
                if (r.outcome === 'in_progress') {
                    return res.json({ success: true, duplicate: true, inProgress: true, hash, s3Key: r.key, document: publicView(r.document),
                        message: "This document is already being processed. Check its status shortly." });
                }
                const { url, expiresInSeconds } = await storage.signedUrl(r.key);
                const duplicate = r.outcome === 'duplicate';
                return res.json({
                    success: true, duplicate, hash, s3Key: r.key, url, urlExpiresInSeconds: expiresInSeconds,
                    alreadyStored: duplicate ? true : r.alreadyStored, document: publicView(r.document),
                    message: duplicate ? "This exact document was already stored. Nothing was written."
                        : (r.alreadyStored ? "This exact file was already stored." : "File stored in AWS S3. Hash generated."),
                });
            }

            // 2b. Without a database (not recommended): store only, nothing is recorded
            const { key, alreadyStored } = await storage.store({
                hash, buffer: file.buffer, contentType: file.detectedMime, originalName: file.safeName,
            });
            const { url, expiresInSeconds } = await storage.signedUrl(key);
            res.json({
                success: true, hash, s3Key: key, url, urlExpiresInSeconds: expiresInSeconds, alreadyStored,
                duplicate: false, document: null,
                message: alreadyStored ? "This exact file was already stored." : "File stored in AWS S3. Hash generated.",
            });

        } catch (err) {
            next(err);   // logged (redacted) and answered generically by errorHandler
        }
    });

    // --- ROUTES: look up an issued document (issuers only) ---
    // Specific routes first so "by-hash" is not read as a document id. Parameters are format-checked before any query.
    const lookup = (pattern, find) => async (req, res, next) => {
        try {
            if (!documents) return res.status(503).json({ success: false, error: 'Document records are not available.', requestId: req.id });
            const value = req.params.value;
            if (!pattern.test(value)) return next(Object.assign(new Error('bad parameter'), { status: 400 }));
            const doc = await find(value);
            if (!doc) return next(Object.assign(new Error('not found'), { status: 404 }));
            res.json({ success: true, document: publicView(doc) });
        } catch (err) { next(err); }
    };
    app.get('/api/documents/by-hash/:value', auth.requireAuth, lookup(/^[a-f0-9]{64}$/, (v) => documents.findBySha256(v)));
    app.get('/api/documents/by-tx/:value', auth.requireAuth, lookup(/^0x[a-fA-F0-9]{64}$/, (v) => documents.findByTransactionHash(v)));
    app.get('/api/documents/:value', auth.requireAuth, lookup(/^[0-9a-f-]{36}$/, (v) => documents.findByDocumentId(v)));

    // --- ROUTES: the blockchain step, reported by the officer's browser and verified against the chain (issuers only) ---
    const chainStep = (handler) => async (req, res, next) => {
        try {
            if (!issuance) return res.status(503).json({ success: false, error: 'Document records are not available.', requestId: req.id });
            if (!/^[0-9a-f-]{36}$/.test(req.params.id)) return next(Object.assign(new Error('bad parameter'), { status: 400 }));
            res.json(await handler(req));
        } catch (err) { next(err); }
    };
    // A wallet transaction was sent: STORED -> BLOCKCHAIN_PENDING (repeating the same call is harmless)
    app.post('/api/documents/:id/chain-pending', auth.requireAuth, chainStep(async (req) =>
        ({ success: true, document: publicView(await issuance.markChainPending(req.params.id, req.user.sub, (req.body || {}).transactionHash)) })));
    // Ask the server to check the transaction on chain: BLOCKCHAIN_PENDING -> ISSUED (or FAILED, or still pending)
    app.post('/api/documents/:id/chain-confirmed', auth.requireAuth, chainStep(async (req) => {
        const r = await issuance.confirmChain(req.params.id, req.user.sub, (req.body || {}).transactionHash);
        return { success: true, state: r.state, document: publicView(r.document) };
    }));
    // The wallet rejected or failed the transaction: -> FAILED, so the record is not left looking half-issued
    app.post('/api/documents/:id/chain-failed', auth.requireAuth, chainStep(async (req) =>
        ({ success: true, document: publicView(await issuance.markChainFailed(req.params.id, req.user.sub, (req.body || {}).reason)) })));

    // --- ROUTE: Health (public, no secrets) ---
    app.get('/api/health', healthHandler({
        app: async () => 'ok',
        s3_config: async () => (bucketName && region ? 'ok' : 'not_configured'),   // config only: no S3 call
        mongodb: documents ? () => documents.ping() : async () => 'not_configured',
        ...chainChecks(),
        ...health,
    }));

    app.use((req, res, next) => next(Object.assign(new Error('not found'), { status: 404 })));
    app.use(errorHandler(logger));

    return app;
}

module.exports = { createApp };
