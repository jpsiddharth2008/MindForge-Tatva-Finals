// Audit trail: who did what to which document, and when. Business data, so it lives in MongoDB (not in the debug logs).
//
// Privacy rules (DPDP Act 2023: logs that hold personal data are themselves personal data):
//   * never any document content, filename, file hash, password, token or attempted username;
//   * the only people-related fields are the issuing officer's account name and a TRUNCATED IP address;
//   * records expire on their own (TTL index), so the collection cannot grow without bound.
const mongoose = require('mongoose');

const ACTIONS = ['ISSUE', 'VERIFY', 'REVOKE', 'LOGIN'];
const OUTCOMES = ['SUCCESS', 'FAILED'];
// Short codes only, never free text, so a reason can never carry a secret.
const REASONS = ['STORED', 'DUPLICATE', 'CHAIN_PENDING', 'CHAIN_CONFIRMED', 'CHAIN_REVERTED', 'WRONG_CONTRACT', 'WRONG_DATA', 'USER_REJECTED',
    'CLIENT_ERROR', 'ERROR', 'DETAILS_MISMATCH', 'BAD_CREDENTIALS', 'MATCH', 'NO_MATCH', 'NOT_ISSUED', 'REVOKED',
    'TAMPERED_CONTENT', 'TAMPERED_VISUAL', 'INCONCLUSIVE', 'QR_MISMATCH'];

const DEFAULT_RETENTION_DAYS = 365;

/** AUDIT_RETENTION_DAYS as a whole number of days (default 365). Junk, zero and negative values fall back to the default. */
function retentionDaysFromEnv(env = process.env) {
    const n = Math.floor(Number(env.AUDIT_RETENTION_DAYS));
    return Number.isFinite(n) && n >= 1 ? n : DEFAULT_RETENTION_DAYS;
}

/** 203.0.113.77 -> 203.0.113.0; 2001:db8:85a3:8d3:1319:8a2e:370:7348 -> 2001:db8:85a3::. Enough to spot abuse, not to identify a person. */
function maskIp(ip) {
    if (!ip || typeof ip !== 'string') return undefined;
    const v4 = ip.replace(/^::ffff:/i, '');
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v4)) return v4.replace(/\.\d{1,3}$/, '.0');
    if (ip === '::1') return ip;                                   // loopback: nothing to truncate
    if (ip.includes(':')) return ip.split(':').slice(0, 3).join(':') + '::';
    return undefined;
}

function buildAuditModel(connection = mongoose, { retentionDays = retentionDaysFromEnv() } = {}) {
    const schema = new mongoose.Schema({
        action: { type: String, required: true, enum: ACTIONS },
        outcome: { type: String, required: true, enum: OUTCOMES },
        reason: { type: String, enum: REASONS },
        actorName: String,                       // the issuing officer's account name; empty for citizens and failed logins
        documentId: { type: String, index: true },
        ip: String,                              // truncated
        createdAt: { type: Date, default: Date.now },
    }, { strict: true, versionKey: false });
    schema.index({ createdAt: 1 }, { expireAfterSeconds: retentionDays * 24 * 60 * 60 });   // the TTL: without it this grows forever
    schema.index({ action: 1, createdAt: -1 });
    return connection.model('AuditEvent', schema);
}

/** The fields a client may see. */
function auditView(e) {
    const o = typeof e.toObject === 'function' ? e.toObject() : e;
    const { action, outcome, reason, actorName, documentId, ip, createdAt } = o;
    return { action, outcome, reason, actorName, documentId, ip, createdAt };
}

function createAudit(AuditEvent, { logger } = {}) {
    return {
        model: AuditEvent,

        /**
         * Writes one event. Auditing must never break the request it describes, so a failure is logged (message only)
         * and swallowed. Returns true if the event was stored.
         */
        async record({ action, outcome, reason, actorName, documentId, ip }) {
            try {
                await AuditEvent.create({ action, outcome, reason, actorName, documentId, ip: maskIp(ip) });
                return true;
            } catch (err) {
                if (logger) logger.warn('could not write audit event', { action, errorName: err && err.name, errorMessage: String((err && err.message) || err) });
                return false;
            }
        },

        /** Events for one document, newest first. */
        async forDocument(documentId, { limit = 100 } = {}) {
            const rows = await AuditEvent.find({ documentId: String(documentId) }).sort({ createdAt: -1, _id: -1 }).limit(limit).lean();
            return rows.map(auditView);
        },

        /** Recent events across all documents, newest first, with optional filters and a `before` cursor. */
        async recent({ action, outcome, limit = 50, before } = {}) {
            const q = {};
            if (action) q.action = action;
            if (outcome) q.outcome = outcome;
            if (before) q.createdAt = { $lt: before };
            const rows = await AuditEvent.find(q).sort({ createdAt: -1, _id: -1 }).limit(limit).lean();
            return rows.map(auditView);
        },
    };
}

module.exports = { buildAuditModel, createAudit, auditView, maskIp, retentionDaysFromEnv, ACTIONS, OUTCOMES, REASONS, DEFAULT_RETENTION_DAYS };
