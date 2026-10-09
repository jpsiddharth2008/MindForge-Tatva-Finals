// Tier 2 end to end: an image of a document -> the fields it says -> a canonical hash, or an honest "could not read".
const { prepareForOcr } = require('./imaging');
const { recognize } = require('./ocr');
const { extractFields, MIN_CONFIDENCE, TEMPLATE } = require('./extract');
const { contentHash, FieldError, diffRecords, lookupKey } = require('./content-hash');

// To call a document TAMPERED, every field that differs must have been read at least this confidently.
// Calibrated on degraded copies of the test certificate (noise, blur, JPEG, shrinking, tone, angle), 44 copies, re-measured on
// tesseract.js 7: all 249 reads at confidence 90 or above were correct, while the 7 wrong reads topped out at 87 (a margin of
// only 3; on tesseract.js 5 it was 4). A measured margin on synthetic data, not a guarantee: re-run the calibration whenever the
// template, the OCR engine version or its settings change.
const MISMATCH_CONFIDENCE = 90;

/**
 * Reads the document. Doubtful fields are READ (with their confidence) rather than refused, because a match against the
 * anchored hash proves the read right; the doubt only matters when the hash does not match (see compareToAnchor).
 *
 * @param {Buffer} image  PNG or JPEG bytes
 * @param {{ocr?: function, minConfidence?: number}} [options]  ocr replaces the real OCR in tests
 * @returns {Promise<
 *   { status: 'READ', fields, record, contentHash, lookupKey, confidences, weak, steps } |
 *   { status: 'UNREADABLE', problems: Array<{field, problem}>, confidences, weak, steps }>}
 * UNREADABLE: a field was missing, ambiguous or unparseable, or an extra printed line could not be read.
 */
async function analyseImage(image, { ocr = recognize, minConfidence = MIN_CONFIDENCE } = {}) {
    const { png, steps } = await prepareForOcr(image, { ignoreRegions: TEMPLATE.ignoreRegions });
    const { lines } = await ocr(png);
    const extracted = extractFields(lines, { minConfidence, strict: false });
    const { confidences, weak } = extracted;
    if (!extracted.ok) return { status: 'UNREADABLE', problems: extracted.problems, confidences, weak, steps };
    try {
        const { hash, record } = contentHash(extracted.fields);
        return { status: 'READ', fields: extracted.fields, record, contentHash: hash, lookupKey: lookupKey(record), confidences, weak, steps };
    } catch (err) {
        if (!(err instanceof FieldError)) throw err;
        // e.g. a date that is not a real date: reported as unreadable for that field, never as a verdict
        return { status: 'UNREADABLE', problems: err.fields.map((field) => ({ field, problem: 'unreadable' })), confidences, weak, steps };
    }
}

/**
 * Compares what the image says with what the issuer anchored.
 *   MATCH         the hashes are equal. Self-verifying: accepted whatever the confidence.
 *   MISMATCH      the hashes differ and every differing field was read confidently. `fieldDiffs` names them, old and new.
 *   INCONCLUSIVE  the document could not be read, or a differing field is one the reader was unsure of.
 * @returns {{status: 'MATCH' | 'MISMATCH' | 'INCONCLUSIVE', fieldDiffs: Array, uncertainFields?: string[]}}
 */
function compareToAnchor(anchoredRecord, anchoredHash, analysis, { mismatchConfidence = MISMATCH_CONFIDENCE } = {}) {
    if (analysis.status !== 'READ') return { status: 'INCONCLUSIVE', fieldDiffs: [], uncertainFields: analysis.problems.map((p) => p.field) };
    if (analysis.contentHash === anchoredHash) return { status: 'MATCH', fieldDiffs: [] };
    const fieldDiffs = diffRecords(anchoredRecord, analysis.record);
    const uncertain = fieldDiffs.filter((d) => {
        const c = analysis.confidences[d.field];                    // confidences use the same names as the diff: "holder", "payload.dob"...
        return d.presented !== null && !(typeof c === 'number' && c >= mismatchConfidence);   // a field that only the anchor has was not read at all
    }).map((d) => d.field);
    if (uncertain.length) return { status: 'INCONCLUSIVE', fieldDiffs, uncertainFields: uncertain };
    return { status: 'MISMATCH', fieldDiffs };
}

module.exports = { analyseImage, compareToAnchor, MISMATCH_CONFIDENCE };
