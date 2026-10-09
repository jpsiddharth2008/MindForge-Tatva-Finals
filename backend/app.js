const express = require('express');
const cors = require('cors');
const multer = require('multer');
const crypto = require('crypto');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const { createAuth } = require('./auth');
const { createLogger } = require('./logger');
const { requestContext, errorHandler } = require('./errors');

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
function createApp({ s3, bucketName, region, auth: authConfig, logger = createLogger({ logDir: null }) }) {
    // Fails closed: the app cannot be built without a valid auth configuration.
    const auth = createAuth(authConfig);
    const app = express();
    app.use(requestContext(logger));
    app.use(cors());
    app.use(express.json({ limit: '10kb' }));

    // File Handling
    const upload = multer({ storage: multer.memoryStorage() });

    // --- ROUTE: Hash only (verification) ---
    // The suspect file never leaves this request: no S3 write, no disk write.
    app.post('/api/hash', upload.single('file'), (req, res) => {
        const file = req.file;
        if (!file) return res.status(400).send("No file.");
        res.json({ success: true, hash: sha256(file.buffer) });
    });

    // --- ROUTE: Issuer login ---
    app.post('/api/auth/login', async (req, res) => {
        const { username, password } = req.body || {};
        const token = await auth.login(username, password);
        if (!token) return res.status(401).json({ success: false, error: 'Invalid credentials.' });
        res.json({ success: true, token });
    });

    // --- ROUTE: Hash & store (issuance) ---
    // Issuers only: requires a valid bearer token.
    app.post('/api/anchor', auth.requireAuth, upload.single('file'), async (req, res, next) => {
        try {
            const file = req.file;
            if (!file) return res.status(400).send("No file.");

            // 1. Create SHA-256 Hash
            const hash = sha256(file.buffer);

            // 2. Upload to AWS S3
            const params = {
                Bucket: bucketName,
                Key: file.originalname, // File name in S3 (content-addressed keys: #51)
                Body: file.buffer,
                ContentType: file.mimetype,
            };

            await s3.send(new PutObjectCommand(params));

            // 3. Send Hash & URL back to Frontend
            const fileUrl = `https://${bucketName}.s3.${region}.amazonaws.com/${file.originalname}`;

            res.json({
                success: true,
                hash: hash,
                url: fileUrl,
                message: "File stored in AWS S3. Hash generated."
            });

        } catch (err) {
            next(err);   // logged (redacted) and answered generically by errorHandler
        }
    });

    app.use(errorHandler(logger));

    return app;
}

module.exports = { createApp };
