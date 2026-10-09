// S3 storage for issued documents: content-addressed keys, server-side encryption, short-lived signed links.
const { PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const MAX_PRESIGN_SECONDS = 300;   // signed links live at most 5 minutes
const SSE_MODES = ['AES256', 'aws:kms'];

/** PRESIGN_TTL_SECONDS clamped to 1..300. Missing or junk values give the maximum, 300. */
function presignTtlFromEnv(env = process.env) {
    const n = Number(env.PRESIGN_TTL_SECONDS);
    return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), MAX_PRESIGN_SECONDS) : MAX_PRESIGN_SECONDS;
}

/** Settings from S3_SSE ('AES256' by default, or 'aws:kms') and S3_KMS_KEY_ID. */
function sseFromEnv(env = process.env) {
    return { mode: env.S3_SSE || 'AES256', kmsKeyId: env.S3_KMS_KEY_ID || undefined };
}

const isAlreadyExists = (err) => err && (err.name === 'PreconditionFailed' || (err.$metadata && err.$metadata.httpStatusCode === 412));

/**
 * @param {object} o
 * @param {object} o.s3          S3Client (or anything with send)
 * @param {string} o.bucketName
 * @param {{mode: string, kmsKeyId?: string}} [o.sse]
 * @param {number} [o.presignTtlSeconds]
 * @param {function} [o.presign]  (command, ttlSeconds) => Promise<string>; replaced in tests
 */
function createStorage({ s3, bucketName, sse = { mode: 'AES256' }, presignTtlSeconds = MAX_PRESIGN_SECONDS, presign }) {
    if (!SSE_MODES.includes(sse.mode)) throw new Error(`S3_SSE must be one of ${SSE_MODES.join(', ')}`);
    const ttl = Math.min(Math.max(1, Math.floor(presignTtlSeconds)), MAX_PRESIGN_SECONDS);
    const sign = presign || ((command, seconds) => getSignedUrl(s3, command, { expiresIn: seconds }));

    /**
     * The key IS the SHA-256 of the content, so two different files can never collide and the same file is stored once.
     * The write is conditional (If-None-Match), so an existing object is never overwritten and no new version is created.
     * @returns {{key: string, alreadyStored: boolean}}
     */
    async function store({ hash, buffer, contentType, originalName }) {
        if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('store needs a SHA-256 hex hash');
        const params = {
            Bucket: bucketName,
            Key: hash,
            Body: buffer,
            ContentType: contentType,
            ServerSideEncryption: sse.mode,
            Metadata: { 'original-filename': originalName },   // sanitised ASCII; the name is metadata, never the key
            IfNoneMatch: '*',
        };
        if (sse.mode === 'aws:kms' && sse.kmsKeyId) params.SSEKMSKeyId = sse.kmsKeyId;
        try {
            await s3.send(new PutObjectCommand(params));
            return { key: hash, alreadyStored: false };
        } catch (err) {
            if (isAlreadyExists(err)) return { key: hash, alreadyStored: true };
            throw err;
        }
    }

    /** A time-limited link for one object. The bucket itself stays private. */
    async function signedUrl(key) {
        const url = await sign(new GetObjectCommand({ Bucket: bucketName, Key: key }), ttl);
        return { url, expiresInSeconds: ttl };
    }

    return { store, signedUrl };
}

module.exports = { createStorage, presignTtlFromEnv, sseFromEnv, MAX_PRESIGN_SECONDS, SSE_MODES };
