const test = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const pre = require("../src/services/preprocess.service");
const ocr = require("../src/services/ocr.service");

/** A synthetic specimen card matching the RESIDENT_ID zone template. */
function cardSvg({ dob = "12/04/2005", name = "ANANYA TEST SUBJECT" } = {}) {
  return Buffer.from(`<svg width="1000" height="630" xmlns="http://www.w3.org/2000/svg">
   <rect width="1000" height="630" fill="white"/>
   <rect x="8" y="8" width="984" height="614" fill="none" stroke="#333" stroke-width="3"/>
   <text x="50" y="78" font-family="DejaVu Sans" font-size="40" font-weight="bold">REPUBLIC OF TESTLAND</text>
   <text x="50" y="225" font-family="DejaVu Sans" font-size="30" fill="#555">Name</text>
   <text x="305" y="225" font-family="DejaVu Sans" font-size="38">${name}</text>
   <text x="50" y="310" font-family="DejaVu Sans" font-size="30" fill="#555">DOB</text>
   <text x="305" y="310" font-family="DejaVu Sans" font-size="36">${dob}</text>
   <text x="50" y="400" font-family="DejaVu Sans" font-size="30" fill="#555">ID No</text>
   <text x="305" y="400" font-family="DejaVu Sans" font-size="38">2341-2341-2346</text>
  </svg>`);
}
const card = (o) => sharp(cardSvg(o)).png().toBuffer();

// ------------------------------------------------------------------- geometry

test("homography maps the source quad onto the destination rectangle", () => {
  const src = [[10, 20], [110, 15], [120, 95], [5, 100]];
  const dst = [[0, 0], [99, 0], [99, 79], [0, 79]];
  const H = pre.solveHomography(src, dst);
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const d = H[6] * x + H[7] * y + H[8];
    const u = (H[0] * x + H[1] * y + H[2]) / d;
    const v = (H[3] * x + H[4] * y + H[5]) / d;
    assert.ok(Math.abs(u - dst[i][0]) < 1e-6 && Math.abs(v - dst[i][1]) < 1e-6);
  }
});

test("corners are ordered top-left, top-right, bottom-right, bottom-left", () => {
  const scrambled = [[100, 90], [5, 5], [5, 95], [110, 8]];
  assert.deepEqual(pre.orderCorners(scrambled), [[5, 5], [110, 8], [100, 90], [5, 95]]);
});

test("a degenerate quad is rejected rather than producing garbage", async () => {
  const img = await card();
  await assert.rejects(
    () => pre.perspectiveCorrect(img, [[0, 0], [0, 0], [0, 0], [0, 0]]),
    (e) => ["DEGENERATE_QUAD", "QUAD_TOO_SMALL"].includes(e.code)
  );
});

test("perspective correction requires exactly four corners", async () => {
  const img = await card();
  await assert.rejects(
    () => pre.perspectiveCorrect(img, [[0, 0], [10, 0]]),
    (e) => e.code === "INVALID_CORNERS"
  );
});

// --------------------------------------------------------------------- deskew

test("skew is detected within 0.5° across the working range", async () => {
  const clean = await card();
  for (const applied of [-6, -4, -2, 0, 2, 4, 6]) {
    const rotated = await sharp(clean)
      .rotate(applied, { background: "#ffffff" })
      .jpeg({ quality: 70 })
      .toBuffer();
    const detected = await pre.estimateSkew(rotated);
    assert.ok(
      Math.abs(detected - applied) <= 0.5,
      `applied ${applied}°, detected ${detected}°`
    );
  }
});

test("deskew leaves a near-zero residual", async () => {
  const clean = await card();
  for (const applied of [-5, 3]) {
    const rotated = await sharp(clean).rotate(applied, { background: "#ffffff" }).toBuffer();
    const { buffer } = await pre.deskew(rotated);
    assert.ok(Math.abs(await pre.estimateSkew(buffer)) <= 0.5);
  }
});

test("a blank image yields no skew estimate rather than a random one", async () => {
  const blank = await sharp({
    create: { width: 400, height: 300, channels: 3, background: "#ffffff" },
  }).png().toBuffer();
  assert.equal(await pre.estimateSkew(blank), 0);
});

// ---------------------------------------------------------------- photometric

test("adaptive binarisation survives a strong illumination gradient", async () => {
  const clean = await card();
  // Simulate one side in shadow — a global threshold would lose that half.
  const shadow = await sharp({
    create: { width: 1000, height: 630, channels: 3, background: "#808080" },
  }).png().toBuffer();
  const uneven = await sharp(clean)
    .composite([{ input: shadow, blend: "multiply" }])
    .toBuffer();

  const bin = await pre.adaptiveBinarise(uneven);
  const { data } = await sharp(bin).raw().toBuffer({ resolveWithObject: true });

  let dark = 0;
  for (let i = 0; i < data.length; i++) if (data[i] === 0) dark++;
  const ratio = dark / data.length;
  // Text should survive as a small but non-trivial fraction of dark pixels.
  assert.ok(ratio > 0.002 && ratio < 0.5, `ink ratio ${ratio}`);
});

test("sharpness score separates a blurred capture from a sharp one", async () => {
  const clean = await card();
  const blurred = await sharp(clean).blur(8).toBuffer();
  const sharpScore = await pre.sharpnessScore(clean);
  const blurScore = await pre.sharpnessScore(blurred);
  assert.ok(sharpScore > blurScore * 3, `sharp ${sharpScore} vs blur ${blurScore}`);
});

test("normalise produces multiple variants for voting", async () => {
  const { variants, meta } = await pre.normalise(await card());
  assert.ok(variants.length >= 3);
  assert.deepEqual(variants.map((v) => v.name), ["grey", "contrast", "binary"]);
  assert.ok(meta.width > 0 && meta.height > 0);
});

// ------------------------------------------------------------------- OCR pure

test("voting prefers agreement over a single high-confidence outlier", () => {
  const r = ocr.vote([
    { text: "ANANYA", confidence: 0.70 },
    { text: "ANANYA", confidence: 0.60 },
    { text: "ANANYB", confidence: 0.95 },
  ]);
  assert.equal(r.text, "ANANYA");
  assert.ok(r.confidence < 0.7, "confidence must be discounted when variants disagree");
});

test("unanimous readings keep their confidence", () => {
  const r = ocr.vote([
    { text: "ANANYA", confidence: 0.9 },
    { text: "ANANYA", confidence: 0.8 },
  ]);
  assert.equal(r.agreement, 1);
  assert.ok(r.confidence > 0.8);
});

test("empty readings produce zero confidence, not a false match", () => {
  const r = ocr.vote([{ text: "", confidence: 0.9 }]);
  assert.equal(r.text, "");
  assert.equal(r.confidence, 0);
});

test("Verhoeff checksum accepts valid and rejects altered identifiers", () => {
  assert.equal(ocr.verhoeffValid("234123412346"), true);
  assert.equal(ocr.verhoeffValid("234123412347"), false);
  assert.equal(ocr.verhoeffValid("234123412356"), false);
});

// ---------------------------------------------------------- OCR integration

test("a blurred capture is refused before wasting an OCR pass", async () => {
  const blurred = await sharp(await card()).blur(12).jpeg({ quality: 50 }).toBuffer();
  await assert.rejects(
    () => ocr.extractFields(blurred, "RESIDENT_ID"),
    (e) => e.code === "IMAGE_TOO_BLURRED"
  );
});

test("an unknown document type is rejected", async () => {
  const img = await card();
  await assert.rejects(
    () => ocr.extractFields(img, "PASSPORT"),
    (e) => e.code === "UNKNOWN_DOC_TYPE"
  );
});

test("fields are read correctly from a degraded, rotated capture", { timeout: 120000 }, async () => {
  const degraded = await sharp(await card())
    .rotate(4, { background: "#ffffff" })
    .jpeg({ quality: 55 })
    .toBuffer();

  const r = await ocr.extractFields(degraded, "RESIDENT_ID");
  assert.match(r.fields.holder, /ANANYA/i);
  assert.match(r.fields.dob, /2005/);
  assert.equal(r.fields.idNumber.replace(/\D/g, ""), "234123412346");
  assert.ok(Math.abs(r.meta.skewAngle + 4) < 1, `skew corrected by ${r.meta.skewAngle}`);
  await ocr.terminate();
});
