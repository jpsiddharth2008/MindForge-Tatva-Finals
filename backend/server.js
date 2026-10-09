require('dotenv').config();
const { S3Client } = require('@aws-sdk/client-s3');
const { createApp } = require('./app');
const { createLogger } = require('./logger');
const { installGracefulShutdown } = require('./security');

// --- CONFIGURATION ---
const BUCKET_NAME = process.env.BUCKET_NAME;
const REGION = process.env.REGION;

// AWS Setup
const s3 = new S3Client({
    region: REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,     // <--- Reads from .env
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY // <--- Reads from .env
    }
});

const auth = {
    jwtSecret: process.env.JWT_SECRET,
    adminUsername: process.env.ADMIN_USERNAME,
    adminPasswordHash: process.env.ADMIN_PASSWORD_HASH,
};

const logger = createLogger();
let app;
try {
    app = createApp({
        s3, bucketName: BUCKET_NAME, region: REGION, auth, logger,
        rateLimits: process.env.RATE_LIMIT_PER_MIN ? { files: { limit: Number(process.env.RATE_LIMIT_PER_MIN) } } : {},
        trustProxy: process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) : false,
    });
} catch (err) {
    console.error(err.message);   // config errors name the missing setting, never its value
    process.exit(1);
}

const PORT = Number(process.env.PORT) || 5000;
const server = app.listen(PORT, () => logger.info(`MindForge AWS Backend running on port ${PORT}`));
installGracefulShutdown(server, logger);
