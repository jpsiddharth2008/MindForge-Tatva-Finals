/**
 * Image preprocessing — geometric and photometric normalisation.
 *
 * OCR accuracy is dominated by what happens here, not by the engine. A clean
 * 300-dpi-equivalent binarised crop will beat a sophisticated model fed a dark,
 * skewed phone photo every time.
 *
 * Pipeline:
 *   1. perspective correction   (flatten an angled photo to top-down)
 *   2. deskew                   (residual rotation, via projection profile)
 *   3. photometric normalisation (grayscale, contrast, glare suppression)
 *   4. resample                 (to the x-height Tesseract performs best at)
 *   5. binarisation             (adaptive — global thresholds die under uneven light)
 *
 * We generate several variants and let the OCR layer vote across them. Which
 * variant wins depends on the capture, so picking one up front loses accuracy.
 */
const sharp = require("sharp");

/** Tesseract's LSTM engine is trained around ~30-40px character height. */
const TARGET_WIDTH = 2000;
const MAX_WIDTH = 4000;

class PreprocessError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PreprocessError";
    this.code = code;
  }
}

// ------------------------------------------------------- perspective warp

/**
 * Solves the 8-parameter homography mapping `src` quad → `dst` rectangle.
 * Gaussian elimination on the standard 8x8 DLT system.
 *
 * @param {Array<[number,number]>} src four corners, clockwise from top-left
 * @param {Array<[number,number]>} dst four corners, same order
 */
function solveHomography(src, dst) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }

  // Gaussian elimination with partial pivoting
  const n = 8;
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    }
    if (Math.abs(A[piv][col]) < 1e-10) {
      throw new PreprocessError("DEGENERATE_QUAD", "Corner points are collinear or duplicated.");
    }
    [A[col], A[piv]] = [A[piv], A[col]];
    [b[col], b[piv]] = [b[piv], b[col]];

    for (let r = col + 1; r < n; r++) {
      const f = A[r][col] / A[col][col];
      for (let c = col; c < n; c++) A[r][c] -= f * A[col][c];
      b[r] -= f * b[col];
    }
  }
  const h = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let c = r + 1; c < n; c++) s -= A[r][c] * h[c];
    h[r] = s / A[r][r];
  }
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

/**
 * Flattens a photographed document to a top-down rectangle.
 *
 * Corners must be supplied — reliable automatic quad detection needs contour
 * finding (OpenCV territory) and a bad auto-detect is worse than none, because
 * it silently crops away a field. The UI collects them; `detectCorners` below
 * offers a coarse fallback.
 *
 * Uses inverse mapping with bilinear sampling, so no output pixel is left unset.
 */
async function perspectiveCorrect(buffer, corners, { width, height } = {}) {
  if (!Array.isArray(corners) || corners.length !== 4) {
    throw new PreprocessError("INVALID_CORNERS", "Exactly four corners are required.");
  }

  const ordered = orderCorners(corners);
  const [tl, tr, br, bl] = ordered;

  const outW = Math.round(width ?? Math.max(dist(tl, tr), dist(bl, br)));
  const outH = Math.round(height ?? Math.max(dist(tl, bl), dist(tr, br)));
  if (outW < 50 || outH < 50) {
    throw new PreprocessError("QUAD_TOO_SMALL", "Selected region is too small to read.");
  }

  const src = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { data, info } = src;
  const ch = info.channels;

  // Inverse homography: output pixel -> source coordinate
  const H = solveHomography(
    [[0, 0], [outW - 1, 0], [outW - 1, outH - 1], [0, outH - 1]],
    ordered.map(([x, y]) => [x, y])
  );

  const out = Buffer.alloc(outW * outH * ch);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const d = H[6] * x + H[7] * y + H[8];
      const sx = (H[0] * x + H[1] * y + H[2]) / d;
      const sy = (H[3] * x + H[4] * y + H[5]) / d;
      const o = (y * outW + x) * ch;

      if (sx < 0 || sy < 0 || sx >= info.width - 1 || sy >= info.height - 1) {
        for (let c = 0; c < ch; c++) out[o + c] = c === 3 ? 255 : 255;
        continue;
      }
      // bilinear
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const fx = sx - x0, fy = sy - y0;
      for (let c = 0; c < ch; c++) {
        const p00 = data[(y0 * info.width + x0) * ch + c];
        const p10 = data[(y0 * info.width + x0 + 1) * ch + c];
        const p01 = data[((y0 + 1) * info.width + x0) * ch + c];
        const p11 = data[((y0 + 1) * info.width + x0 + 1) * ch + c];
        out[o + c] =
          p00 * (1 - fx) * (1 - fy) + p10 * fx * (1 - fy) +
          p01 * (1 - fx) * fy + p11 * fx * fy;
      }
    }
  }

  return sharp(out, { raw: { width: outW, height: outH, channels: ch } }).png().toBuffer();
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Orders arbitrary corners as [top-left, top-right, bottom-right, bottom-left]. */
function orderCorners(pts) {
  const sorted = [...pts].sort((a, b) => a[1] - b[1]);
  const [t1, t2] = sorted.slice(0, 2).sort((a, b) => a[0] - b[0]);
  const [b1, b2] = sorted.slice(2).sort((a, b) => a[0] - b[0]);
  return [t1, t2, b2, b1];
}

// -------------------------------------------------------------- deskew

/**
 * Estimates residual rotation using a projection profile.
 *
 * Text lines produce sharp peaks in the horizontal projection when the page is
 * level; the variance of that profile is maximised at the correct angle. Robust
 * for document images and needs no feature detection.
 */
async function estimateSkew(buffer, { range = 8, step = 0.25 } = {}) {
  // Downscale aggressively — skew estimation needs layout, not detail.
  const { data, info } = await sharp(buffer)
    .greyscale()
    .resize({ width: 600, fit: "inside", withoutEnlargement: true })
    .normalise()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Binarise against a global mean/σ threshold. Working with discrete ink
  // pixels rather than grey levels keeps antialiasing from dominating.
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i];
  const mean = sum / data.length;
  let varSum = 0;
  for (let i = 0; i < data.length; i++) varSum += (data[i] - mean) ** 2;
  const sd = Math.sqrt(varSum / data.length);
  const threshold = mean - sd * 0.4;

  // Collect ink coordinates, centred. We rotate these points rather than the
  // image: no resampling, no canvas growth, so every candidate angle is scored
  // on identical data. Rotating the raster instead makes the comparison
  // meaningless, because each angle produces a different amount of padding.
  const cx = info.width / 2;
  const cy = info.height / 2;
  const xs = [];
  const ys = [];
  for (let y = 0; y < info.height; y++) {
    const base = y * info.width;
    for (let x = 0; x < info.width; x++) {
      if (data[base + x] < threshold) {
        xs.push(x - cx);
        ys.push(y - cy);
      }
    }
  }
  if (xs.length < 50) return 0; // too little ink to judge

  const span = Math.ceil(Math.hypot(info.width, info.height)) + 2;
  const offset = Math.floor(span / 2);
  const bins = new Float64Array(span);

  let best = { angle: 0, score: -Infinity };
  for (let angle = -range; angle <= range; angle += step) {
    const rad = (angle * Math.PI) / 180;
    const s = Math.sin(rad);
    const c = Math.cos(rad);
    bins.fill(0);

    for (let i = 0; i < xs.length; i++) {
      const yr = -xs[i] * s + ys[i] * c;
      bins[(yr + offset) | 0] += 1;
    }

    // Sum of squared bin counts is maximised when ink concentrates into few
    // rows — i.e. when text lines are horizontal. Total ink is constant across
    // angles, so the comparison is fair.
    let score = 0;
    for (let i = 0; i < span; i++) score += bins[i] * bins[i];
    if (score > best.score) best = { angle, score };
  }

  // Returns the DETECTED skew of the input, not the correction. A page skewed
  // by +4 degrees returns +4; deskew() applies the negation.
  return best.angle;
}

async function deskew(buffer, { maxAngle = 8 } = {}) {
  const angle = await estimateSkew(buffer, { range: maxAngle });
  if (Math.abs(angle) < 0.25) return { buffer, angle: 0, detectedSkew: angle };
  const out = await sharp(buffer).rotate(-angle, { background: "#ffffff" }).toBuffer();
  return { buffer: out, angle: -angle, detectedSkew: angle };
}

// ----------------------------------------------------- photometric + binarise

/**
 * Local (adaptive) binarisation.
 *
 * A global threshold fails on phone photos because one corner is in shadow and
 * another has glare. We approximate Sauvola by subtracting a heavily blurred
 * copy — the blur estimates local background illumination, so thresholding the
 * difference is illumination-invariant.
 */
async function adaptiveBinarise(buffer, { window = 25, offset = 10 } = {}) {
  const grey = sharp(buffer).greyscale().normalise();
  const { data, info } = await grey.raw().toBuffer({ resolveWithObject: true });

  const blurred = await sharp(data, { raw: { ...info, channels: 1 } })
    .blur(Math.max(1, window / 3))
    .raw()
    .toBuffer();

  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = data[i] < blurred[i] - offset ? 0 : 255;
  }
  return sharp(out, { raw: { width: info.width, height: info.height, channels: 1 } })
    .png()
    .toBuffer();
}

/** Resample so character height lands in Tesseract's sweet spot. */
async function resample(buffer, target = TARGET_WIDTH) {
  const meta = await sharp(buffer).metadata();
  if (!meta.width) throw new PreprocessError("UNREADABLE_IMAGE", "Could not read image dimensions.");
  if (meta.width >= target && meta.width <= MAX_WIDTH) return buffer;
  const width = Math.min(MAX_WIDTH, Math.max(target, meta.width));
  return sharp(buffer)
    .resize({ width, kernel: sharp.kernel.lanczos3, withoutEnlargement: false })
    .toBuffer();
}

// ------------------------------------------------------------------ pipeline

/**
 * Full normalisation.
 *
 * @param {Buffer} buffer
 * @param {object} [opts]
 * @param {Array<[number,number]>} [opts.corners] enables perspective correction
 * @returns {Promise<{normalised: Buffer, variants: Array<{name,buffer}>, meta: object}>}
 */
async function normalise(buffer, opts = {}) {
  let img = buffer;
  const meta = { perspectiveCorrected: false, skewAngle: 0 };

  if (opts.corners) {
    img = await perspectiveCorrect(img, opts.corners);
    meta.perspectiveCorrected = true;
  }

  const sk = await deskew(img, { maxAngle: opts.maxSkew ?? 8 });
  img = sk.buffer;
  meta.skewAngle = sk.angle;

  img = await resample(img, opts.targetWidth ?? TARGET_WIDTH);

  const base = await sharp(img).greyscale().normalise().toBuffer();
  const info = await sharp(base).metadata();
  meta.width = info.width;
  meta.height = info.height;

  // Several renderings; the OCR layer votes across them. Which one wins varies
  // with the capture, so committing to a single variant loses accuracy.
  const variants = [
    { name: "grey", buffer: base },
    { name: "contrast", buffer: await sharp(base).linear(1.35, -25).sharpen().toBuffer() },
    { name: "binary", buffer: await adaptiveBinarise(base) },
  ];

  return { normalised: base, variants, meta };
}

/**
 * Crops a region of interest given normalised (0..1) coordinates.
 * Template-driven zone extraction is substantially more accurate than
 * full-page OCR plus regex, because each zone gets its own character
 * whitelist and segmentation mode.
 */
async function cropRegion(buffer, { x, y, w, h }, { pad = 0.01 } = {}) {
  const meta = await sharp(buffer).metadata();
  const px = Math.max(0, Math.round((x - pad) * meta.width));
  const py = Math.max(0, Math.round((y - pad) * meta.height));
  const pw = Math.min(meta.width - px, Math.round((w + pad * 2) * meta.width));
  const ph = Math.min(meta.height - py, Math.round((h + pad * 2) * meta.height));
  if (pw <= 0 || ph <= 0) {
    throw new PreprocessError("INVALID_REGION", "Region falls outside the image.");
  }
  return sharp(buffer).extract({ left: px, top: py, width: pw, height: ph }).toBuffer();
}

/** Sharpness proxy — flags captures too blurred to read before wasting an OCR pass. */
async function sharpnessScore(buffer) {
  const { data, info } = await sharp(buffer)
    .greyscale()
    .resize({ width: 800, fit: "inside", withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });

  let sum = 0, sumSq = 0, n = 0;
  for (let y = 1; y < info.height - 1; y++) {
    for (let x = 1; x < info.width - 1; x++) {
      const i = y * info.width + x;
      const lap =
        -4 * data[i] + data[i - 1] + data[i + 1] + data[i - info.width] + data[i + info.width];
      sum += lap; sumSq += lap * lap; n++;
    }
  }
  const mean = sum / n;
  return sumSq / n - mean * mean; // variance of Laplacian
}

module.exports = {
  normalise,
  perspectiveCorrect,
  deskew,
  estimateSkew,
  adaptiveBinarise,
  resample,
  cropRegion,
  sharpnessScore,
  solveHomography,
  orderCorners,
  PreprocessError,
};
