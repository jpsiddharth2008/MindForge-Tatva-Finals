require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const crypto = require('crypto');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const app = express();
app.use(cors());

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

// File Handling
const upload = multer({ storage: multer.memoryStorage() });

// --- ROUTE: Upload & Hash ---
app.post('/upload', upload.single('file'), async (req, res) => {
    try {
        const file = req.file;
        if (!file) return res.status(400).send("No file.");

        // 1. Create SHA-256 Hash
        const hash = crypto.createHash('sha256').update(file.buffer).digest('hex');

        // 2. Upload to AWS S3
        const params = {
            Bucket: BUCKET_NAME,
            Key: file.originalname, // File name in S3
            Body: file.buffer,
            ContentType: file.mimetype,
        };

        await s3.send(new PutObjectCommand(params));

        // 3. Send Hash & URL back to Frontend
        const fileUrl = `https://${BUCKET_NAME}.s3.${REGION}.amazonaws.com/${file.originalname}`;

        res.json({ 
            success: true, 
            hash: hash, 
            url: fileUrl,
            message: "File stored in AWS S3. Hash generated."
        });

    } catch (err) {
        console.error(err);
        res.status(500).send("Upload Failed: " + err.message);
    }
});

app.listen(5000, () => console.log("MindForge AWS Backend running on port 5000"));