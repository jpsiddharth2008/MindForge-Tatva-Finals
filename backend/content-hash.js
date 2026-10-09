// Tier 2: the canonical content hash. Two copies of the same document (original file, JPEG, scan, photo, WhatsApp forward)
// have different bytes but say the same thing, so they must hash the same. A document whose words were changed must not.
//
// The hash is taken over a canonical record of the document's FIELDS, never over pixels:
//   normalise each field (Unicode form, spacing, case, ID punctuation, date format, number format)
//   -> arrange them in a fixed shape with sorted keys -> SHA-256 under a version tag.
const crypto = require('crypto');

const VERSION_TAG = 'mindforge:content:v1\n';          // bump when the rules below change, so old hashes are never silently reinterpreted
const REQUIRED = ['docType', 'issuer', 'holder', 'idNumber', 'issuedOn'];

/** Thrown when the fields cannot be put in canonical form. `fields` names the offenders. Never contains field values. */
class FieldError extends Error {
    constructor(message, fields) {
        super(message);
        this.name = 'FieldError';
        this.fields = fields;
    }
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** Unicode form, one space between words, trimmed, upper case. */
function norm(value) {
    return String(value).normalize('NFKC').replace(/[  -​  　\s]+/g, ' ').trim().toUpperCase();
}

/** IDs are compared by their letters and digits only: "B-210 123 cs" and "B210123CS" are the same ID. */
function normId(value) {
    return norm(value).replace(/[^A-Z0-9]/g, '');
}

function isRealDate(y, m, d) {
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/**
 * Accepts 2026-06-15, 15-06-2026, 15/06/2026, 15.06.2026, "15 Jun 2026", "15 June 2026", "June 15, 2026".
 * Numeric dates with the year last are DAY first (the Indian convention). Returns YYYY-MM-DD, or throws FieldError.
 */
function toISODate(value) {
    const s = norm(value).replace(/,/g, '');
    let y; let m; let d;
    let match;
    if ((match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s))) [y, m, d] = [match[1], match[2], match[3]];
    else if ((match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s))) [d, m, y] = [match[1], match[2], match[3]];
    else if ((match = /^(\d{1,2}) ([A-Z]{3})[A-Z]* (\d{4})$/.exec(s)) && MONTHS.includes(match[2])) [d, m, y] = [match[1], MONTHS.indexOf(match[2]) + 1, match[3]];
    else if ((match = /^([A-Z]{3})[A-Z]* (\d{1,2}) (\d{4})$/.exec(s)) && MONTHS.includes(match[1])) [m, d, y] = [MONTHS.indexOf(match[1]) + 1, match[2], match[3]];
    else throw new FieldError('unrecognised date', []);
    [y, m, d] = [Number(y), Number(m), Number(d)];
    if (!isRealDate(y, m, d)) throw new FieldError('not a real calendar date', []);
    return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** "8.70" and "08.7" are the same number; a value that is a whole date becomes YYYY-MM-DD; anything else is normalised text. */
function normValue(value) {
    const s = norm(value);
    if (/^\d+(\.\d+)?$/.test(s)) return s.replace(/^0+(?=\d)/, '').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
    try { return toISODate(s); } catch { return s; }
}

/** Field names are labels, not values: lower case, so reports read "payload.dob" rather than "payload.DOB". */
const normKey = (k) => norm(k).toLowerCase();

/** JSON with every object's keys sorted, so equal data always serialises to equal text. */
function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

/**
 * The canonical record. Throws FieldError (naming the fields, never their values) if a required field is missing or a
 * date cannot be understood: the caller reports that as "could not read", never as a verdict.
 */
function canonicalRecord(fields) {
    const f = fields || {};
    const missing = REQUIRED.filter((k) => f[k] === undefined || f[k] === null || norm(f[k]) === '');
    if (missing.length) throw new FieldError('missing required fields', missing);
    let issuedOn;
    try { issuedOn = toISODate(f.issuedOn); } catch (e) { throw new FieldError(e.message, ['issuedOn']); }
    const payload = {};
    for (const [k, v] of Object.entries(f.payload || {})) {
        const key = normKey(k);
        if (key === '') continue;
        if (v === undefined || v === null || norm(v) === '') continue;     // an empty extra field is the same as an absent one
        payload[key] = normValue(v);
    }
    const idNumber = normId(f.idNumber);
    if (idNumber === '') throw new FieldError('missing required fields', ['idNumber']);
    return { docType: norm(f.docType), issuer: norm(f.issuer), holder: norm(f.holder), idNumber, issuedOn, payload };
}

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

/** @returns {{hash: string, record: object}} */
function contentHash(fields) {
    const record = canonicalRecord(fields);
    return { hash: sha256(VERSION_TAG + stableStringify(record)), record };
}

/**
 * A key for finding the record of "this person's document of this type from this issuer" even when a field was altered.
 * It is a hash, so the ID number itself is not stored in the lookup index.
 */
function lookupKey({ issuer, idNumber, docType }) {
    return sha256(`mindforge:lookup:v1\n${norm(issuer)}|${norm(docType)}|${normId(idNumber)}`);
}

/** A canonical record as one flat object: payload fields become "payload.<key>". */
function flatRecord(r) {
    const out = {};
    for (const [k, v] of Object.entries(r || {})) {
        if (k === 'payload') for (const [pk, pv] of Object.entries(v || {})) out[`payload.${pk}`] = pv;
        else out[k] = v;
    }
    return out;
}

/** Flat list of every field that differs between two canonical records. Payload fields are named "payload.<key>". */
function diffRecords(anchored, presented) {
    const a = flatRecord(anchored);
    const p = flatRecord(presented);
    return [...new Set([...Object.keys(a), ...Object.keys(p)])].sort()
        .filter((k) => (a[k] ?? null) !== (p[k] ?? null))
        .map((k) => ({ field: k, anchored: a[k] ?? null, presented: p[k] ?? null }));
}

module.exports = { canonicalRecord, contentHash, lookupKey, diffRecords, flatRecord, stableStringify, toISODate, norm, normId, normValue, FieldError, REQUIRED, VERSION_TAG };
