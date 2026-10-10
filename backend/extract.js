// Label-anchored field extraction from OCR output, for ONE controlled certificate template.
// Fields are found by their printed labels ("Name:", "DOB:", "Register No:"), not by where they sit on the page, so a
// scan that shifts or crops the layout still reads correctly. Anything unclear is reported as a problem, never guessed:
// the caller turns problems into INCONCLUSIVE, which is always safer than a wrong verdict.
const { norm } = require('./content-hash');

/** The one supported template. To support another, add another object like this. */
const TEMPLATE = {
    name: 'certificate-v1',
    // Parts of the page that are not text. OCR is blind to them: left alone, grain and texture in a photo box get "read" as
    // stray letters at the end of nearby lines. The pictures themselves are checked by Tier 3 (appearance), not here.
    // Coordinates are fractions of the flattened page, CROPPED TO ITS PRINTED CONTENT (see imaging.cropToContent): { x0, y0, x1, y1 }.
    // The QR is ignored for that reason and for one more: the content hash the QR carries is READ FROM these fields, so if OCR
    // could see the QR, stamping it would change the very hash printed inside it. See stamp.js. Padded 8px beyond the stamped
    // box so no module of the code can graze the boundary.
    ignoreRegions: [
        { name: 'photo', x0: 0.78, y0: 0.24, x1: 1.0, y1: 0.51 },
        { name: 'qr', x0: 0.6971, y0: 0.5365, x1: 0.9771, y1: 0.9786 },
    ],
    // Where the photo sits (same coordinates). Tier 3 hashes this region on its own: a swapped photo shows up there far more
    // clearly than in its 4x4 grid tile, where the white margin around the photo dominates the hash.
    photoRegion: { x0: 0.8044, y0: 0.2655, x1: 0.9792, y1: 0.481 },
    // Where stamp.js puts the QR, in the same coordinates. Derived from stamp.BOX; stamp.test.js re-derives it, so the two
    // cannot drift apart silently.
    // The ignore region starts at x 0.697; the rightmost field ink on the page (the end of the "Programme" line) is at 0.583,
    // so no field is ever masked.
    qrRegion: { x0: 0.7058, y0: 0.5503, x1: 0.9728, y1: 0.9717 },
    fields: [
        { key: 'issuer', labels: ['Issuer'] },
        { key: 'docType', labels: ['Document'] },
        { key: 'holder', labels: ['Name'] },
        { key: 'idNumber', labels: ['Register No', 'Registration No', 'Reg No', 'Roll No'], idFormat: 'LDDDDDDLL' },
        { key: 'issuedOn', labels: ['Issued On', 'Date of Issue'] },
        { key: 'payload.dob', labels: ['DOB', 'Date of Birth'] },
        { key: 'payload.programme', labels: ['Programme', 'Program'] },
        { key: 'payload.cgpa', labels: ['CGPA'] },
    ],
};

const MIN_CONFIDENCE = 75;   // Tesseract reports 0-100 per word; clean print scores 90+. Tunable.

const labelKey = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function editDistance(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    return d[a.length][b.length];
}

/** Which template field does this printed label belong to? One slip of OCR (not for short labels) is forgiven. */
function matchLabel(printed, template) {
    const key = labelKey(printed);
    if (!key) return null;
    let best = null;
    for (const field of template.fields) {
        for (const label of field.labels) {
            const want = labelKey(label);
            const dist = editDistance(key, want);
            const allowed = want.length >= 6 ? 1 : 0;
            if (dist <= allowed && (!best || dist < best.dist)) best = { field, dist };
        }
    }
    return best && best.field;
}

// Letters that OCR confuses with digits and the reverse, applied ONLY where the ID format says which kind goes there.
const TO_DIGIT = { O: '0', Q: '0', D: '0', I: '1', L: '1', Z: '2', S: '5', B: '8', G: '6' };
const TO_LETTER = { 0: 'O', 1: 'I', 2: 'Z', 5: 'S', 8: 'B', 6: 'G' };

/** Repairs OCR slips in an ID when its shape is known (L = letter, D = digit). A wrong-shaped ID is returned unchanged. */
function repairId(value, format) {
    const id = String(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!format || id.length !== format.length) return id;
    return [...id].map((ch, i) => {
        if (format[i] === 'D') return /\d/.test(ch) ? ch : (TO_DIGIT[ch] || ch);
        return /[A-Z]/.test(ch) ? ch : (TO_LETTER[ch] || ch);
    }).join('');
}

/** Splits an OCR line into its printed label and the words of its value. Needs a colon; lines without one are not fields. */
function splitLine(line) {
    const text = line.text.trim();
    const colon = text.search(/[:;]/);
    if (colon < 1) return null;
    const label = text.slice(0, colon);
    const value = text.slice(colon + 1).trim();
    const words = line.words || [];
    const at = words.findIndex((w) => /[:;]/.test(w.text));          // the word that carries the colon
    let valueWords = [];
    if (at >= 0) {
        const glued = words[at].text.split(/[:;]/).slice(1).join('').trim();   // "No:B210123CS" has the value stuck to the colon
        valueWords = words.slice(glued ? at : at + 1);
    }
    return { label, value, valueWords };
}

/**
 * @param {Array<{text: string, confidence?: number, words?: Array<{text: string, confidence: number}>}>} lines OCR lines
 * @returns {{fields: object, confidences: object, problems: Array<{field: string, problem: string}>, ok: boolean}}
 *   problems: 'missing' (a template field was not found), 'low_confidence', 'unreadable' (value could not be parsed),
 *   'ambiguous' (the same label appears twice with different values). ok is true only when there are none.
 *   weak: every field read below minConfidence. With strict:true (the default) a weak template field is also a problem and its
 *   value is withheld. With strict:false its value is passed on and only listed in `weak`, for callers that settle doubt
 *   another way (a match against the anchored hash proves the read right, whatever its confidence).
 *   An unreadable EXTRA labelled line is always a problem: it cannot be hashed, so it could hide an added claim.
 */
function extractFields(lines, { template = TEMPLATE, minConfidence = MIN_CONFIDENCE, strict = true } = {}) {
    const found = {};            // key -> [{ value, confidence }]
    const extras = {};           // unknown labelled lines, kept so an added claim changes the hash
    const problems = [];
    const weak = [];

    for (const line of lines) {
        const parts = splitLine(line);
        if (!parts) continue;
        const field = matchLabel(parts.label, template);
        const confidence = parts.valueWords.length
            ? Math.min(...parts.valueWords.map((w) => (typeof w.confidence === 'number' ? w.confidence : 0)))
            : (typeof line.confidence === 'number' ? line.confidence : 0);
        if (!field) {
            const extraKey = labelKey(parts.label);
            if (!extraKey || !parts.value) continue;
            (extras[extraKey] = extras[extraKey] || []).push({ value: parts.value, confidence, label: parts.label.trim() });
            continue;
        }
        (found[field.key] = found[field.key] || []).push({ value: parts.value, confidence });
    }

    const fields = { payload: {} };
    const confidences = {};
    const set = (key, value) => { if (key.startsWith('payload.')) fields.payload[key.slice(8)] = value; else fields[key] = value; };

    for (const field of template.fields) {
        const hits = found[field.key];
        if (!hits) { problems.push({ field: field.key, problem: 'missing' }); continue; }
        const values = new Set(hits.map((h) => norm(field.idFormat ? repairId(h.value, field.idFormat) : h.value)));
        if (values.size > 1) { problems.push({ field: field.key, problem: 'ambiguous' }); continue; }
        const hit = hits.reduce((a, b) => (b.confidence < a.confidence ? b : a));
        confidences[field.key] = hit.confidence;
        if (!hit.value) { problems.push({ field: field.key, problem: 'unreadable' }); continue; }
        if (hit.confidence < minConfidence) {
            weak.push({ field: field.key, confidence: hit.confidence });
            if (strict) { problems.push({ field: field.key, problem: 'low_confidence' }); continue; }
        }
        set(field.key, field.idFormat ? repairId(hit.value, field.idFormat) : hit.value);
    }

    for (const [key, hits] of Object.entries(extras)) {
        const name = `payload.${key}`;
        const values = new Set(hits.map((h) => norm(h.value)));
        const conf = Math.min(...hits.map((h) => h.confidence));
        confidences[name] = conf;
        if (values.size > 1) problems.push({ field: name, problem: 'ambiguous' });
        else if (conf < minConfidence) { weak.push({ field: name, confidence: conf }); problems.push({ field: name, problem: 'low_confidence' }); }
        else fields.payload[key] = hits[0].value;     // an extra claim printed on the document is part of what it says
    }

    return { fields, confidences, problems, weak, ok: problems.length === 0 };
}

module.exports = { extractFields, repairId, matchLabel, splitLine, TEMPLATE, MIN_CONFIDENCE };
