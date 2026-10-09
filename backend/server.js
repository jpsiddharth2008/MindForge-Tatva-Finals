require('dotenv').config();
const { S3Client } = require('@aws-sdk/client-s3');
const { createApp } = require('./app');

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

let app;
try {
    app = createApp({ s3, bucketName: BUCKET_NAME, region: REGION, auth });
} catch (err) {
    console.error(err.message);   // config errors name the missing setting, never its value
    process.exit(1);
}

app.listen(5000, () => console.log("MindForge AWS Backend running on port 5000"));
