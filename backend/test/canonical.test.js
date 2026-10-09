const test = require("node:test");
const assert = require("node:assert/strict");
const {
  computeContentHash,
  normaliseField,
  normaliseDate,
  canonicalString,
  diffRecords,
  FIELD_TYPES,
  CanonicalError,
} = require("../src/services/canonical.service");

const BASE = {
  docType: "RESIDENT_ID",
  issuer: "Republic of Testland — Civil Registry",
  holder: "Ananya Test Subject",
  idNumber: "0000-0000-0001",
  dob: "2005-04-12",
};
const hashOf = (f, c) => computeContentHash(f, "RESIDENT_ID", c).contentHash;

// ---------------------------------------------------------------- injectivity

test("length-delimited serialisation prevents field-boundary collisions", () => {
  // The bug in naive concatenation: both flatten to "JOHNDOE123".
  const a = canonicalString({ holder: "JOHN", idNumber: "DOE123" });
  const b = canonicalString({ holder: "JOHNDOE", idNumber: "123" });
  assert.notEqual(a, b);

  const hA = hashOf({ ...BASE, holder: "JOHN", idNumber: "DOE123" });
  const hB = hashOf({ ...BASE, holder: "JOHNDOE", idNumber: "123" });
  assert.notEqual(hA, hB, "different field splits must not collide");
});

test("key order does not affect the hash", () => {
  const reordered = {
    dob: BASE.dob, idNumber: BASE.idNumber, holder: BASE.holder,
    issuer: BASE.issuer, docType: BASE.docType,
  };
  assert.equal(hashOf(BASE), hashOf(reordered));
});

// ------------------------------------------------------------- OCR resilience

test("capture noise does not change the hash", () => {
  const noisy = {
    docType: "  resident_id  ",
    issuer: "REPUBLIC  OF   TESTLAND - CIVIL REGISTRY",
    holder: "  ananya   test  subject ",
    idNumber: "0000 0000 0001",
    dob: "12/04/2005",
  };
  assert.equal(hashOf(noisy), hashOf(BASE), "whitespace/case/format must normalise away");
});

test("every date rendering collapses to one value", () => {
  for (const d of ["2005-04-12", "12/04/2005", "12-04-2005", "12-APR-2005", "20050412"]) {
    assert.equal(normaliseDate(d), "2005-04-12", `failed for ${d}`);
  }
});

test("two-digit years are refused rather than guessed", () => {
  // "01/01/90" could be 1990 or 2090. Guessing silently corrupts the hash.
  assert.equal(normaliseDate("01/01/90"), null);
});

test("OCR confusables are corrected in ID fields only", () => {
  // O→0 and I→1 in an ID number
  assert.equal(normaliseField("OOOO-OOOO-OOOI", FIELD_TYPES.ALNUM), "000000000001");
  // but a name containing those letters must survive intact
  assert.equal(normaliseField("Lion Oliver", FIELD_TYPES.TEXT), "LION OLIVER");
});

test("word boundaries in names are preserved", () => {
  // Stripping all whitespace would make these collide.
  assert.notEqual(
    normaliseField("RAM KUMAR", FIELD_TYPES.TEXT),
    normaliseField("RAMKUMAR", FIELD_TYPES.TEXT)
  );
});

// ------------------------------------------------------------ tamper detection

test("altering one digit of DOB changes the hash", () => {
  assert.notEqual(hashOf(BASE), hashOf({ ...BASE, dob: "2003-04-12" }));
});

test("altering the holder name changes the hash", () => {
  assert.notEqual(hashOf(BASE), hashOf({ ...BASE, holder: "Someone Else" }));
});

test("a different person on the same template does not collide", () => {
  const other = { ...BASE, holder: "Bharath Test Subject", idNumber: "0000-0000-0002" };
  assert.notEqual(hashOf(BASE), hashOf(other));
});

test("diff names the altered field with before and after", () => {
  const anchored = computeContentHash(BASE, "RESIDENT_ID").record;
  const presented = computeContentHash({ ...BASE, dob: "2003-04-12" }, "RESIDENT_ID").record;
  const diffs = diffRecords(anchored, presented);
  assert.equal(diffs.length, 1);
  assert.deepEqual(diffs[0], {
    field: "dob", anchored: "2005-04-12", presented: "2003-04-12",
  });
});

// -------------------------------------------------------------------- honesty

test("low OCR confidence is reported, not hidden", () => {
  const r = computeContentHash(BASE, "RESIDENT_ID", { holder: 0.42 });
  assert.equal(r.confident, false);
  assert.deepEqual(r.lowConfidence, ["holder"]);
});

test("unparsable date is flagged instead of guessed", () => {
  const r = computeContentHash({ ...BASE, dob: "sometime in 2005" }, "RESIDENT_ID");
  assert.equal(r.confident, false);
  assert.deepEqual(r.unparsable, ["dob"]);
});

test("missing required field throws rather than hashing a blank", () => {
  assert.throws(
    () => computeContentHash({ ...BASE, idNumber: "" }, "RESIDENT_ID"),
    (e) => e instanceof CanonicalError && e.code === "MISSING_FIELDS"
  );
});

test("unknown document type is rejected", () => {
  assert.throws(
    () => computeContentHash(BASE, "PASSPORT"),
    (e) => e.code === "UNKNOWN_DOC_TYPE"
  );
});

test("hash is a 0x-prefixed 32-byte hex string", () => {
  assert.match(hashOf(BASE), /^0x[0-9a-f]{64}$/);
});
