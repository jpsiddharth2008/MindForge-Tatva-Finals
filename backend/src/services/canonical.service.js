/**
 * Tier 2 — canonical content hashing.
 *
 * Turns the messy, non-deterministic output of OCR into a deterministic
 * fingerprint of the document's *information*, so a genuine credential still
 * verifies after being printed, scanned, photographed or recompressed.
 *
 * Three properties this module must guarantee:
 *
 *   1. DETERMINISM   — the same document always yields the same hash,
 *                      regardless of capture device, lighting or angle.
 *   2. INJECTIVITY   — two documents with different data can never collide.
 *                      Naive concatenation breaks this: {name:"JOHN",
 *                      id:"DOE123"} and {name:"JOHNDOE", id:"123"} both
 *                      flatten to "JOHNDOE123". We length-delimit instead.
 *   3. HONESTY       — when OCR confidence is too low to trust, return
 *                      INCONCLUSIVE rather than a confident wrong hash.
 */
const crypto = require("crypto");

/** Fields below this mean confidence are not trustworthy enough to hash. */
const DEFAULT_MIN_CONFIDENCE = 0.75;

/**
 * Field types drive normalisation. Applying numeric confusable-mapping to a
 * name would corrupt it ("LIO" → "L10"), so the type must be declared.
 */
const FIELD_TYPES = {
  TEXT: "text",     // names, issuer, free text
  ALNUM: "alnum",   // ID numbers, registration numbers
  NUMERIC: "numeric",
  DATE: "date",
};

/**
 * OCR confusable pairs. Only applied to ALNUM/NUMERIC fields, where the
 * intended character class is known. Direction is toward digits because the
 * surrounding context in an ID number is numeric.
 */
const CONFUSABLES_TO_DIGIT = {
  O: "0", o: "0", Q: "0", D: "0",
  I: "1", l: "1", i: "1", "|": "1",
  Z: "2", z: "2",
  S: "5", s: "5",
  G: "6",
  T: "7",
  B: "8",
  g: "9", q: "9",
};

class CanonicalError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CanonicalError";
    this.code = code;
    this.details = details;
  }
}

// ------------------------------------------------------------- normalisation

/** Unicode-normalise, collapse whitespace, strip zero-width characters. */
function baseClean(value) {
  return String(value)
    .normalize("NFKC")
    .replace(/[​-‍﻿]/g, "") // zero-width
    .replace(/\s+/g, " ")
    .trim();
}

function normaliseText(value) {
  return baseClean(value)
    .toUpperCase()
    // Keep inter-word spaces: "RAM KUMAR" must not equal "RAMKUMAR".
    .replace(/[^A-Z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normaliseAlnum(value) {
  const cleaned = baseClean(value).replace(/[\s\-/.]/g, "");
  // Map confusables only where the field is known to be alphanumeric ID data.
  const mapped = cleaned
    .split("")
    .map((ch) => (/[0-9]/.test(ch) ? ch : CONFUSABLES_TO_DIGIT[ch] ?? ch))
    .join("");
  return mapped.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normaliseNumeric(value) {
  return normaliseAlnum(value).replace(/[^0-9]/g, "");
}

const MONTHS = {
  JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
  JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12",
};

/**
 * Collapses every plausible date rendering to ISO `YYYY-MM-DD`.
 * Returns null when the value cannot be parsed unambiguously — the caller
 * must treat that as INCONCLUSIVE rather than guessing.
 */
function normaliseDate(value) {
  const raw = baseClean(value).toUpperCase();

  // 1990-01-01 / 1990/01/01
  let m = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return iso(m[1], m[2], m[3]);

  // 01-01-1990 / 01/01/1990  — day-first (Indian convention)
  m = raw.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (m) return iso(m[3], m[2], m[1]);

  // 01-JAN-1990 / 01 JAN 1990
  m = raw.match(/^(\d{1,2})[-/. ]([A-Z]{3})[A-Z]*[-/. ](\d{4})$/);
  if (m && MONTHS[m[2]]) return iso(m[3], MONTHS[m[2]], m[1]);

  // 19900101
  m = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return iso(m[1], m[2], m[3]);

  // Deliberately NOT handled: two-digit years. "01/01/90" is ambiguous
  // between 1990 and 2090, and a wrong guess silently corrupts the hash.
  return null;
}

function iso(y, mo, d) {
  const Y = Number(y), M = Number(mo), D = Number(d);
  if (M < 1 || M > 12 || D < 1 || D > 31) return null;
  return `${String(Y).padStart(4, "0")}-${String(M).padStart(2, "0")}-${String(D).padStart(2, "0")}`;
}

function normaliseField(value, type) {
  switch (type) {
    case FIELD_TYPES.ALNUM:   return normaliseAlnum(value);
    case FIELD_TYPES.NUMERIC: return normaliseNumeric(value);
    case FIELD_TYPES.DATE:    return normaliseDate(value);
    case FIELD_TYPES.TEXT:
    default:                  return normaliseText(value);
  }
}

// ------------------------------------------------------ canonical serialising

/**
 * Length-delimited, key-sorted serialisation.
 *
 * Each entry is `<keyLen>:<key>=<valLen>:<value>;` so no combination of field
 * values can be reinterpreted as a different combination. This is the property
 * that naive concatenation lacks.
 */
function canonicalString(record) {
  return Object.keys(record)
    .sort()
    .map((k) => {
      const v = record[k] == null ? "" : String(record[k]);
      return `${k.length}:${k}=${v.length}:${v};`;
    })
    .join("");
}

// ------------------------------------------------------------------ public API

/**
 * @typedef {Object} FieldSpec
 * @property {string} type      one of FIELD_TYPES
 * @property {boolean} [required=true]
 */

/** Schema for the documents we issue. Add new document types here. */
const SCHEMAS = {
  RESIDENT_ID: {
    docType:  { type: FIELD_TYPES.TEXT },
    issuer:   { type: FIELD_TYPES.TEXT },
    holder:   { type: FIELD_TYPES.TEXT },
    idNumber: { type: FIELD_TYPES.ALNUM },
    dob:      { type: FIELD_TYPES.DATE },
  },
  DEGREE: {
    docType:    { type: FIELD_TYPES.TEXT },
    issuer:     { type: FIELD_TYPES.TEXT },
    holder:     { type: FIELD_TYPES.TEXT },
    idNumber:   { type: FIELD_TYPES.ALNUM },
    programme:  { type: FIELD_TYPES.TEXT },
    issuedOn:   { type: FIELD_TYPES.DATE },
    grade:      { type: FIELD_TYPES.TEXT, required: false },
  },
};

/**
 * Normalise extracted fields against a schema.
 *
 * @param {object} fields        raw values from OCR
 * @param {string} docType       key into SCHEMAS
 * @param {object} [confidences] per-field OCR confidence, 0..1
 * @param {object} [opts]
 * @returns {{record: object, lowConfidence: string[], unparsable: string[]}}
 */
function normaliseRecord(fields, docType, confidences = {}, opts = {}) {
  const schema = SCHEMAS[docType];
  if (!schema) {
    throw new CanonicalError("UNKNOWN_DOC_TYPE", `No schema for document type "${docType}".`);
  }
  const minConfidence = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;

  const record = {};
  const lowConfidence = [];
  const unparsable = [];
  const missing = [];

  for (const [name, spec] of Object.entries(schema)) {
    const raw = fields[name];
    const required = spec.required !== false;

    if (raw == null || String(raw).trim() === "") {
      if (required) missing.push(name);
      record[name] = "";
      continue;
    }

    const conf = confidences[name];
    if (conf != null && conf < minConfidence) lowConfidence.push(name);

    const value = normaliseField(raw, spec.type);
    if (value === null) {
      unparsable.push(name);
      record[name] = "";
      continue;
    }
    record[name] = value;
  }

  if (missing.length) {
    throw new CanonicalError(
      "MISSING_FIELDS",
      `Required fields could not be read: ${missing.join(", ")}`,
      { missing }
    );
  }

  return { record, lowConfidence, unparsable };
}

/**
 * Compute the Tier 2 content hash.
 *
 * @returns {{contentHash: string, record: object, canonical: string,
 *            confident: boolean, lowConfidence: string[], unparsable: string[]}}
 */
function computeContentHash(fields, docType, confidences = {}, opts = {}) {
  const { record, lowConfidence, unparsable } = normaliseRecord(
    fields, docType, confidences, opts
  );

  const canonical = canonicalString(record);
  const contentHash = crypto.createHash("sha256").update(canonical, "utf8").digest("hex");

  return {
    contentHash: `0x${contentHash}`,
    record,
    canonical,
    // The caller must surface INCONCLUSIVE rather than a verdict when false.
    confident: lowConfidence.length === 0 && unparsable.length === 0,
    lowConfidence,
    unparsable,
  };
}

/** Tier 1 — SHA-256 of the raw file bytes. */
function computeByteHash(buffer) {
  return `0x${crypto.createHash("sha256").update(buffer).digest("hex")}`;
}

/**
 * Field-level diff between the anchored record and the presented one.
 * This is what turns "something changed" into "the date of birth changed
 * from 2005-04-12 to 2003-04-12".
 */
function diffRecords(anchored, presented) {
  const keys = new Set([...Object.keys(anchored || {}), ...Object.keys(presented || {})]);
  const diffs = [];
  for (const field of [...keys].sort()) {
    const a = anchored?.[field] ?? null;
    const p = presented?.[field] ?? null;
    if (a !== p) diffs.push({ field, anchored: a, presented: p });
  }
  return diffs;
}

module.exports = {
  computeContentHash,
  computeByteHash,
  normaliseRecord,
  normaliseField,
  normaliseDate,
  canonicalString,
  diffRecords,
  SCHEMAS,
  FIELD_TYPES,
  CanonicalError,
  DEFAULT_MIN_CONFIDENCE,
};
