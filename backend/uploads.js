// Upload validation: size limit, declared type, real type (magic bytes) and a safe filename.
// Uploaded bytes are only ever hashed and stored. They are never rendered, executed or evaluated.
const path = require('path');
const multer = require('multer');
const FileType = require('file-type');

const MB = 1024 * 1024;
const DEFAULT_MAX_MB = 10;

// What we accept: the detected type must be one of these, and must agree with what the client declared.
const ALLOWED = { 'application/pdf': 'PDF', 'image/png': 'PNG', 'image/jpeg': 'JPEG' };
const ALLOWED_TEXT = 'Allowed types: PDF, PNG, JPEG.';

/** An error whose message is safe to show the client (written by us, never copied from input). */
class UploadError extends Error {
    constructor(status, publicMessage) {
        super(publicMessage);
        this.name = 'UploadError';
        this.status = status;
        this.publicMessage = publicMessage;
    }
}

/** MAX_FILE_SIZE_MB as a number of megabytes. Anything missing, non-numeric or not positive falls back to 10. */
function maxMbFromEnv(env = process.env) {
    const n = Number(env.MAX_FILE_SIZE_MB);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_MB;
}

/**
 * The client controls the filename, so it is treated as hostile text: path parts, control and bidi characters,
 * and anything outside a small safe set are removed. Used only as metadata, never as a path.
 */
function sanitizeFilename(name) {
    const base = path.basename(String(name || '').replace(/\\/g, '/'));
    const cleaned = base
        .normalize('NFKC')
        .replace(/[^A-Za-z0-9._ -]/g, '_')   // also removes NUL, control characters and RTL override
        .replace(/_{2,}/g, '_')
        .replace(/^[.\s_-]+/, '')            // no hidden files or leading separators
        .trim()
        .slice(-100);                        // keep the end: that is where the extension is
    return cleaned || 'document';
}

/** Middleware pair: multer with limits and a first-pass type filter, then a magic-byte check on the real bytes. */
function singleFileUpload({ maxFileSizeMb = maxMbFromEnv() } = {}) {
    const maxBytes = Math.floor(maxFileSizeMb * MB);

    const multerMw = multer({
        storage: multer.memoryStorage(),
        // +1 because busboy stops AT the limit and flags a file of exactly maxBytes as too large; the exact check is below
        limits: { fileSize: maxBytes + 1, files: 1, fields: 5, parts: 8, fieldSize: 16 * 1024 },   // fieldSize: the JSON "fields" text
        fileFilter: (req, file, cb) => {
            // The declared type is attacker-controlled: this only rejects the obvious early. Magic bytes decide.
            if (!ALLOWED[file.mimetype]) return cb(new UploadError(400, `Unsupported file type. ${ALLOWED_TEXT}`));
            cb(null, true);
        },
    }).single('file');

    const tooLarge = () => new UploadError(413, `File too large. The limit is ${maxFileSizeMb} MB.`);
    const receive = (req, res, next) => multerMw(req, res, (err) => {
        if (!err) return req.file && req.file.size > maxBytes ? next(tooLarge()) : next();
        if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
            return next(tooLarge());
        }
        if (err instanceof multer.MulterError && err.code === 'LIMIT_FIELD_VALUE') return next(new UploadError(400, 'The document details are too long.'));
        if (err instanceof multer.MulterError) return next(new UploadError(400, 'Upload must be a single file in the "file" field.'));
        next(err);
    });

    const checkContent = async (req, res, next) => {
        const file = req.file;
        if (!file) return next();    // routes decide what "no file" means
        try {
            const detected = await FileType.fromBuffer(file.buffer);
            if (!detected || !ALLOWED[detected.mime]) throw new UploadError(400, `File content is not a supported type. ${ALLOWED_TEXT}`);
            if (detected.mime !== file.mimetype) throw new UploadError(400, 'File content does not match its declared type.');
            file.detectedMime = detected.mime;                 // from the bytes, not from the client
            file.safeName = sanitizeFilename(file.originalname);
            next();
        } catch (err) {
            next(err);
        }
    };

    return [receive, checkContent];
}

module.exports = { singleFileUpload, sanitizeFilename, maxMbFromEnv, UploadError, ALLOWED, DEFAULT_MAX_MB };
