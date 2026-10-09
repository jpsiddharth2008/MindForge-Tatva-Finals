/**
 * OCR — structured field extraction.
 *
 * Three decisions drive accuracy here, in order of impact:
 *
 *   1. ZONE-BASED EXTRACTION. We own the template, so we crop each field's
 *      region and OCR it in isolation. Full-page OCR plus regex is far worse:
 *      the engine has to segment an unknown layout, and a stray glyph from a
 *      neighbouring field silently corrupts the match.
 *
 *   2. PER-FIELD CHARACTER WHITELISTS. An ID number restricted to [0-9] cannot
 *      come back with "O" or "I". This single setting eliminates most of the
 *      confusable-character class before normalisation ever sees it.
 *
 *   3. MULTI-VARIANT VOTING. Each zone is read against several preprocessing
 *      variants. Agreement across variants is a far better confidence signal
 *      than the engine's own per-word score, which is poorly calibrated on
 *      degraded captures.
 *
 * Tesseract runs locally. That is deliberate: a cloud OCR API would make the
 * demo dependent on conference wifi, and this pipeline must work offline.
 */
const { createWorker, PSM, OEM } = require("tesseract.js");
const preprocess = require("./preprocess.service");

/** Below this, a capture is too blurred to attempt — fail fast as INCONCLUSIVE. */
const MIN_SHARPNESS = 40;

class OcrError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "OcrError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Character sets per field kind. Restricting the alphabet is the highest-value
 * accuracy lever available.
 */
const CHARSETS = {
  name: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz ",
  digits: "0123456789",
  alnum: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-/",
  date: "0123456789-/ JANFEBMRPYULGSOCTNVDEabcdefghijklmnopqrstuvwxyz",
  text: "", // unrestricted
};

/**
 * Template zones in normalised (0..1) coordinates. Measured once against the
 * reference render; every capture is warped to this frame before cropping.
 */
const TEMPLATES = {
  RESIDENT_ID: {
    docTypeConstant: "RESIDENT_ID",
    fields: {
      holder:   { region: { x: 0.30, y: 0.28, w: 0.62, h: 0.11 }, charset: "name",   psm: PSM.SINGLE_LINE },
      dob:      { region: { x: 0.30, y: 0.42, w: 0.40, h: 0.09 }, charset: "date",   psm: PSM.SINGLE_LINE },
      idNumber: { region: { x: 0.30, y: 0.56, w: 0.55, h: 0.11 }, charset: "alnum",  psm: PSM.SINGLE_LINE },
      issuer:   { region: { x: 0.05, y: 0.04, w: 0.90, h: 0.12 }, charset: "text",   psm: PSM.SINGLE_LINE },
    },
  },
  DEGREE: {
    docTypeConstant: "DEGREE",
    fields: {
      issuer:    { region: { x: 0.05, y: 0.03, w: 0.90, h: 0.14 }, charset: "text",  psm: PSM.SINGLE_LINE },
      holder:    { region: { x: 0.15, y: 0.32, w: 0.70, h: 0.10 }, charset: "name",  psm: PSM.SINGLE_LINE },
      programme: { region: { x: 0.15, y: 0.45, w: 0.70, h: 0.10 }, charset: "text",  psm: PSM.SINGLE_LINE },
      idNumber:  { region: { x: 0.10, y: 0.60, w: 0.45, h: 0.08 }, charset: "alnum", psm: PSM.SINGLE_LINE },
      issuedOn:  { region: { x: 0.55, y: 0.60, w: 0.38, h: 0.08 }, charset: "date",  psm: PSM.SINGLE_LINE },
      grade:     { region: { x: 0.10, y: 0.72, w: 0.35, h: 0.08 }, charset: "alnum", psm: PSM.SINGLE_LINE },
    },
  },
};

// --------------------------------------------------------------- worker pool

let _worker = null;
let _workerPromise = null;

/**
 * One long-lived worker. Tesseract's startup cost (loading the LSTM model) is
 * ~1-2s — paying that per request would dominate latency.
 */
async function getWorker({ lang = "eng" } = {}) {
  if (_worker) return _worker;
  if (_workerPromise) return _workerPromise;

  _workerPromise = (async () => {
    const w = await createWorker(lang, OEM.LSTM_ONLY);
    _worker = w;
    _workerPromise = null;
    return w;
  })();
  return _workerPromise;
}

async function terminate() {
  if (_worker) {
    await _worker.terminate();
    _worker = null;
  }
}

// ----------------------------------------------------------------- recognise

async function recogniseZone(worker, image, { charset, psm }) {
  await worker.setParameters({
    tessedit_pageseg_mode: psm ?? PSM.SINGLE_LINE,
    tessedit_char_whitelist: CHARSETS[charset] ?? "",
    preserve_interword_spaces: "1",
    user_defined_dpi: "300",
  });
  const { data } = await worker.recognize(image);
  const words = data.words ?? [];
  const confidence = words.length
    ? words.reduce((s, w) => s + (w.confidence ?? 0), 0) / words.length / 100
    : (data.confidence ?? 0) / 100;
  return { text: (data.text ?? "").trim(), confidence };
}

/**
 * Picks the winning reading across preprocessing variants.
 *
 * Agreement is weighted above raw engine confidence: two variants producing the
 * same string is stronger evidence than one variant reporting high confidence,
 * because engine confidence is poorly calibrated on degraded input.
 */
function vote(readings) {
  const groups = new Map();
  for (const r of readings) {
    if (!r.text) continue;
    const key = r.text.replace(/\s+/g, " ").trim().toUpperCase();
    if (!groups.has(key)) groups.set(key, { text: r.text, votes: 0, confSum: 0 });
    const g = groups.get(key);
    g.votes += 1;
    g.confSum += r.confidence;
  }
  if (groups.size === 0) return { text: "", confidence: 0, agreement: 0 };

  const ranked = [...groups.values()]
    .map((g) => ({ ...g, meanConf: g.confSum / g.votes }))
    .sort((a, b) => (b.votes - a.votes) || (b.meanConf - a.meanConf));

  const winner = ranked[0];
  const agreement = winner.votes / readings.length;

  // Unanimity is itself evidence; a lone reading is discounted.
  const confidence = Math.min(1, winner.meanConf * (0.6 + 0.4 * agreement));
  return { text: winner.text, confidence, agreement, candidates: ranked.length };
}

// ------------------------------------------------------------------ checksum

/** Verhoeff — the checksum Aadhaar-style identifiers use. */
const D = [
  [0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],
  [3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],
  [6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],
  [9,8,7,6,5,4,3,2,1,0]];
const P = [
  [0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],
  [8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],
  [2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];

function verhoeffValid(num) {
  const digits = String(num).replace(/\D/g, "").split("").reverse().map(Number);
  if (!digits.length) return false;
  let c = 0;
  digits.forEach((d, i) => { c = D[c][P[i % 8][d]]; });
  return c === 0;
}

// -------------------------------------------------------------------- extract

/**
 * Extract structured fields from a document image.
 *
 * @param {Buffer} buffer
 * @param {string} docType key into TEMPLATES
 * @param {object} [opts]
 * @param {Array<[number,number]>} [opts.corners] enables perspective correction
 * @param {boolean} [opts.validateChecksum=false]
 * @returns {Promise<{fields, confidences, meta, warnings}>}
 */
async function extractFields(buffer, docType, opts = {}) {
  const template = TEMPLATES[docType];
  if (!template) {
    throw new OcrError("UNKNOWN_DOC_TYPE", `No OCR template for "${docType}".`);
  }

  const sharpness = await preprocess.sharpnessScore(buffer);
  if (sharpness < MIN_SHARPNESS) {
    throw new OcrError(
      "IMAGE_TOO_BLURRED",
      "The image is too blurred to read reliably. Please recapture in better light.",
      { sharpness, threshold: MIN_SHARPNESS }
    );
  }

  const { normalised, variants, meta } = await preprocess.normalise(buffer, {
    corners: opts.corners,
  });

  const worker = await getWorker({ lang: opts.lang });
  const fields = {};
  const confidences = {};
  const warnings = [];

  for (const [name, spec] of Object.entries(template.fields)) {
    const readings = [];
    for (const variant of variants) {
      try {
        const crop = await preprocess.cropRegion(variant.buffer, spec.region);
        readings.push(await recogniseZone(worker, crop, spec));
      } catch (err) {
        warnings.push(`${name}/${variant.name}: ${err.message}`);
      }
    }

    const result = vote(readings);
    fields[name] = result.text;
    confidences[name] = result.confidence;

    if (result.agreement < 1 && result.text) {
      warnings.push(
        `${name}: variants disagreed (${result.candidates} readings, ` +
        `${Math.round(result.agreement * 100)}% agreement)`
      );
    }
  }

  fields.docType = template.docTypeConstant;
  confidences.docType = 1;

  if (opts.validateChecksum && fields.idNumber) {
    const digitsOnly = fields.idNumber.replace(/\D/g, "");
    if (digitsOnly.length >= 12 && !verhoeffValid(digitsOnly)) {
      // A failing checksum almost always means a misread digit, not a forgery.
      // Lower confidence so the caller returns INCONCLUSIVE rather than a
      // confident wrong hash.
      confidences.idNumber = Math.min(confidences.idNumber, 0.5);
      warnings.push("idNumber: checksum failed — likely an OCR misread");
    }
  }

  return {
    fields,
    confidences,
    meta: { ...meta, sharpness, variantCount: variants.length },
    warnings,
    normalised,
  };
}

/**
 * Fallback for documents without a zone template: full-page OCR, then
 * label-anchored regex. Less accurate — zones are strongly preferred.
 */
async function extractByLabels(buffer, labelMap, opts = {}) {
  const { variants } = await preprocess.normalise(buffer, { corners: opts.corners });
  const worker = await getWorker({ lang: opts.lang });

  await worker.setParameters({
    tessedit_pageseg_mode: PSM.AUTO,
    tessedit_char_whitelist: "",
    preserve_interword_spaces: "1",
  });
  const { data } = await worker.recognize(variants[0].buffer);
  const text = data.text ?? "";

  const fields = {};
  const confidences = {};
  for (const [field, patterns] of Object.entries(labelMap)) {
    for (const re of [].concat(patterns)) {
      const m = text.match(re);
      if (m && m[1]) {
        fields[field] = m[1].trim();
        confidences[field] = (data.confidence ?? 0) / 100;
        break;
      }
    }
  }
  return { fields, confidences, rawText: text, meta: { mode: "labels" } };
}

module.exports = {
  extractFields,
  extractByLabels,
  recogniseZone,
  vote,
  verhoeffValid,
  getWorker,
  terminate,
  TEMPLATES,
  CHARSETS,
  MIN_SHARPNESS,
  OcrError,
};
