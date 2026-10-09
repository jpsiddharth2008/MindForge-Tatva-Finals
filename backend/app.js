const express = require('express');
const cors = require('cors');
const multer = require('multer');
const crypto = require('crypto');
const { PutObjectCommand } = require('@aws-sdk/client-s3');

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

/**
 * Builds the API. `s3` is an S3Client (or anything with `send`), injected so
 * tests can prove which routes write to the bucket.
 *
 * Verification and issuance are separate routes on purpose:
 * - POST /api/hash   hashes in memory and stores NOTHING. Used to check a suspect file.
 * - POST /api/anchor hashes and stores in S3. Used by the issuing officer before the chain write.
 */
function createApp({ s3, bucketName, region }) {
    const app = express();
    app.use(cors());

    // File Handling
    const upload = multer({ storage: multer.memoryStorage() });

    // --- ROUTE: Hash only (verification) ---
    // The suspect file never leaves this request: no S3 write, no disk write.
    app.post('/api/hash', upload.single('file'), (req, res) => {
        const file = req.file;
        if (!file) return res.status(400).send("No file.");
        res.json({ success: true, hash: sha256(file.buffer) });
    });

    // --- ROUTE: Hash & store (issuance) ---
    // TODO(#48): restrict to authenticated issuers once real auth lands.
    app.post('/api/anchor', upload.single('file'), async (req, res) => {
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
            console.error(err);
            res.status(500).send("Upload Failed: " + err.message);
        }
    });

    return app;
}

module.exports = { createApp };
