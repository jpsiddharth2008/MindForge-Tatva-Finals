// Request ids, request logging and the one place errors become HTTP responses.
// Clients get a generic message plus a request id; full detail stays in the (redacted) server log.
const crypto = require('crypto');
const { scrubString } = require('./logger');

const GENERIC = {
    400: 'Bad request.',
    401: 'Authentication required.',
    403: 'Forbidden.',
    404: 'Not found.',
    413: 'Request too large.',
    429: 'Too many requests.',
};

/** Gives every request an id, returned in the X-Request-Id header and used in every log line about it. */
function requestContext(logger) {
    return (req, res, next) => {
        req.id = crypto.randomUUID();
        res.setHeader('X-Request-Id', req.id);
        const started = Date.now();
        res.on('finish', () => {
            // path only: query strings can carry tokens, and bodies are document contents, so neither is logged
            logger.info('request', { requestId: req.id, method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - started });
        });
        next();
    };
}

function statusOf(err) {
    if (err && err.name === 'MulterError') return err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    const s = err && (err.status || err.statusCode);
    return Number.isInteger(s) && s >= 400 && s < 600 ? s : 500;
}

/** Express error middleware. Never sends err.message or a stack to the client. */
function errorHandler(logger) {
    // eslint-disable-next-line no-unused-vars
    return (err, req, res, next) => {
        const status = statusOf(err);
        // Only err.message is logged (scrubbed by the logger), never the whole error object.
        logger.error('request failed', {
            requestId: req.id, method: req.method, path: req.path, status,
            errorName: err && err.name, errorMessage: scrubString(String((err && err.message) || err)),
        });
        if (res.headersSent) return;
        res.status(status).json({
            success: false,
            error: status >= 500 ? 'Internal server error.' : (GENERIC[status] || 'Request could not be processed.'),
            requestId: req.id,
        });
    };
}

module.exports = { requestContext, errorHandler };
