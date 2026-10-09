// Logging that cannot leak credentials. Everything passes through redact() before it is written.
const path = require('path');
const winston = require('winston');

const REDACTED = '[REDACTED]';

// Any object key matching this has its value replaced, whatever the value is.
const SECRET_KEY = /pass(word|wd)?|token|private[-_]?key|authorization|secret|cookie|api[-_]?key|credential|mongodb_uri|mongo_uri|connection[-_]?string/i;

// Secrets that show up inside free text, such as an error message that embeds a connection string.
const SECRET_PATTERNS = [
    [/mongodb(\+srv)?:\/\/[^\s'"]+/gi, `mongodb://${REDACTED}`],
    [/\b(?:postgres(?:ql)?|mysql|redis|amqp):\/\/[^\s'"]+/gi, `db://${REDACTED}`],
    [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
    [/\b0x[a-fA-F0-9]{64}\b/g, REDACTED],                        // private keys and full tx-style hashes
    [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, REDACTED],   // JWTs
    [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`],
    [/(secret|password|passwd|token|api[-_]?key)\s*[=:]\s*[^\s,;'"]+/gi, `$1=${REDACTED}`],
];

function scrubString(s) {
    return SECRET_PATTERNS.reduce((out, [re, to]) => out.replace(re, to), s);
}

// Deep copy with secrets removed. Errors become {name, message, code}: never the whole object, never the stack.
function redact(value, seen = new WeakSet()) {
    if (typeof value === 'string') return scrubString(value);
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    if (value instanceof Error) {
        return { name: value.name, message: scrubString(String(value.message)), ...(value.code ? { code: scrubString(String(value.code)) } : {}) };
    }
    if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;   // never log file contents
    if (Array.isArray(value)) return value.map((v) => redact(v, seen));
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? REDACTED : redact(v, seen);
    return out;
}

// winston format that applies redact() to the message and every extra field.
const redactFormat = winston.format((info) => {
    const { level, message, ...rest } = info;
    const clean = redact(rest);
    const out = { level, message: typeof message === 'string' ? scrubString(message) : redact(message), ...clean };
    // winston keeps symbol-keyed fields; carry them across so later formats still work
    for (const sym of Object.getOwnPropertySymbols(info)) out[sym] = info[sym];
    return out;
})();

/**
 * @param {object} opts
 * @param {string} [opts.level]       default LOG_LEVEL or 'info'
 * @param {string} [opts.logDir]      where the rotating files go; pass null for console-only
 * @param {boolean} [opts.silent]     no console output (tests)
 * @param {object[]} [opts.transports] extra winston transports (tests use a memory transport)
 */
function createLogger({ level = process.env.LOG_LEVEL || 'info', logDir = process.env.LOG_DIR || 'logs', silent = false, transports = [] } = {}) {
    const all = [...transports];
    all.push(new winston.transports.Console({ silent }));   // a muted transport keeps winston from warning when silent
    if (logDir) {
        all.push(new winston.transports.File({
            filename: path.join(logDir, 'app.log'),
            maxsize: 5 * 1024 * 1024,   // 5 MB
            maxFiles: 3,
            tailable: true,
        }));
    }
    return winston.createLogger({
        level,
        format: winston.format.combine(winston.format.timestamp(), redactFormat, winston.format.json()),
        transports: all,
        exitOnError: false,
    });
}

module.exports = { createLogger, redact, scrubString, REDACTED };
