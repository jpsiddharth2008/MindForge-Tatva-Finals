// Turns a photo of a document into a flat, upright, high-contrast page that OCR can read.
//   1. find the page against its background (brightest large blob) and flatten the perspective, or
//   2. if the image is already the page (a scan, screenshot or forward), just straighten any small tilt.
// Everything works on raw greyscale pixel buffers, so each step can be tested against geometry with a known answer.
const sharp = require('sharp');

const WORK_SIDE = 1400;       // longest side used for analysis and output (px)
const MIN_PAGE_FRACTION = 0.25;   // a detected page smaller than this share of the picture is not trusted

/** @returns {Promise<{data: Uint8Array, width: number, height: number}>} greyscale pixels, longest side <= WORK_SIDE */
async function loadGray(input) {
    const img = sharp(input, { failOn: 'error' }).rotate();          // honour the camera's EXIF orientation
    const meta = await img.metadata();
    const scale = Math.min(1, WORK_SIDE / Math.max(meta.width, meta.height));
    const { data, info } = await img
        .resize(Math.round(meta.width * scale), Math.round(meta.height * scale), { fit: 'fill' })
        .flatten({ background: '#ffffff' }).greyscale().raw().toBuffer({ resolveWithObject: true });
    return { data: new Uint8Array(data), width: info.width, height: info.height };
}

/** Otsu's method: the grey level that best separates dark from bright. */
function otsu(data) {
    const hist = new Array(256).fill(0);
    for (const v of data) hist[v]++;
    const total = data.length;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0; let wB = 0; let best = 0; let threshold = 128;
    for (let t = 0; t < 256; t++) {
        wB += hist[t];
        if (!wB) continue;
        const wF = total - wB;
        if (!wF) break;
        sumB += t * hist[t];
        const between = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2;
        if (between > best) { best = between; threshold = t; }
    }
    return threshold;
}

/** Share of the picture's outermost rows/columns that are bright. A page that fills the frame has nearly all of them bright. */
function borderBrightShare(mask, width, height) {
    let bright = 0; let n = 0;
    const m = Math.max(1, Math.floor(Math.min(width, height) * 0.01));
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (x < m || y < m || x >= width - m || y >= height - m) { n++; bright += mask[y * width + x]; }
        }
    }
    return bright / n;
}

/** Largest 4-connected blob of 1s in a mask: returns its pixel indices. Iterative, so big images cannot overflow the stack. */
function largestBlob(mask, width, height) {
    const seen = new Uint8Array(mask.length);
    let best = [];
    const stack = new Int32Array(mask.length);
    for (let start = 0; start < mask.length; start++) {
        if (!mask[start] || seen[start]) continue;
        let top = 0; stack[top++] = start; seen[start] = 1;
        const blob = [];
        while (top) {
            const i = stack[--top];
            blob.push(i);
            const x = i % width; const y = (i - x) / width;
            if (x > 0 && mask[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack[top++] = i - 1; }
            if (x < width - 1 && mask[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack[top++] = i + 1; }
            if (y > 0 && mask[i - width] && !seen[i - width]) { seen[i - width] = 1; stack[top++] = i - width; }
            if (y < height - 1 && mask[i + width] && !seen[i + width]) { seen[i + width] = 1; stack[top++] = i + width; }
        }
        if (blob.length > best.length) best = blob;
    }
    return best;
}

/** Closes small holes (printed text inside the page) so the page is one solid blob. Box blur on the mask, then re-threshold. */
function closeMask(mask, width, height, radius = 6) {
    const integral = new Int32Array((width + 1) * (height + 1));
    for (let y = 0; y < height; y++) {
        let row = 0;
        for (let x = 0; x < width; x++) {
            row += mask[y * width + x];
            integral[(y + 1) * (width + 1) + x + 1] = integral[y * (width + 1) + x + 1] + row;
        }
    }
    const out = new Uint8Array(mask.length);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const x0 = Math.max(0, x - radius); const x1 = Math.min(width, x + radius + 1);
            const y0 = Math.max(0, y - radius); const y1 = Math.min(height, y + radius + 1);
            const sum = integral[y1 * (width + 1) + x1] - integral[y0 * (width + 1) + x1] - integral[y1 * (width + 1) + x0] + integral[y0 * (width + 1) + x0];
            out[y * width + x] = sum * 2 > (x1 - x0) * (y1 - y0) ? 1 : 0;
        }
    }
    return out;
}

function polygonArea(p) {
    let a = 0;
    for (let i = 0; i < p.length; i++) { const [x1, y1] = p[i]; const [x2, y2] = p[(i + 1) % p.length]; a += x1 * y2 - x2 * y1; }
    return Math.abs(a) / 2;
}

/**
 * Finds the page's four corners [topLeft, topRight, bottomRight, bottomLeft], or null when the picture IS the page
 * (it fills the frame) or no convincing page is found.
 */
function findPageCorners(gray) {
    const { data, width, height } = gray;
    const t = otsu(data);
    const mask = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) mask[i] = data[i] > t ? 1 : 0;
    if (borderBrightShare(mask, width, height) > 0.9) return null;           // already a full-frame page
    const blob = largestBlob(closeMask(mask, width, height), width, height);
    if (blob.length < width * height * MIN_PAGE_FRACTION) return null;
    let tl = null; let tr = null; let br = null; let bl = null;
    for (const i of blob) {
        const x = i % width; const y = (i - x) / width;
        if (!tl || x + y < tl[0] + tl[1]) tl = [x, y];
        if (!br || x + y > br[0] + br[1]) br = [x, y];
        if (!tr || x - y > tr[0] - tr[1]) tr = [x, y];
        if (!bl || x - y < bl[0] - bl[1]) bl = [x, y];
    }
    const quad = [tl, tr, br, bl];
    return polygonArea(quad) < width * height * MIN_PAGE_FRACTION ? null : quad;
}

/** Solves the 3x3 perspective matrix H (as 9 numbers, h33 = 1) that maps each src point to its dst point. */
function solveHomography(src, dst) {
    const A = [];
    for (let i = 0; i < 4; i++) {
        const [x, y] = src[i]; const [u, v] = dst[i];
        A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
        A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
    }
    for (let c = 0; c < 8; c++) {                                            // Gaussian elimination with partial pivoting
        let p = c;
        for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
        if (Math.abs(A[p][c]) < 1e-12) throw new Error('degenerate corner points');
        [A[c], A[p]] = [A[p], A[c]];
        for (let r = 0; r < 8; r++) {
            if (r === c) continue;
            const f = A[r][c] / A[c][c];
            for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k];
        }
    }
    return [...A.map((row, i) => row[8] / row[i]), 1];
}

function applyH(H, x, y) {
    const w = H[6] * x + H[7] * y + H[8];
    return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

/** Resamples `gray` through H, where H maps OUTPUT coordinates to INPUT coordinates. Bilinear. Outside the source is white. */
function warp(gray, H, outW, outH) {
    const { data, width, height } = gray;
    const out = new Uint8Array(outW * outH);
    for (let y = 0; y < outH; y++) {
        for (let x = 0; x < outW; x++) {
            const [sx, sy] = applyH(H, x, y);
            if (sx < 0 || sy < 0 || sx > width - 1 || sy > height - 1) { out[y * outW + x] = 255; continue; }
            const x0 = Math.floor(sx); const y0 = Math.floor(sy);
            const x1 = Math.min(x0 + 1, width - 1); const y1 = Math.min(y0 + 1, height - 1);
            const fx = sx - x0; const fy = sy - y0;
            const top = data[y0 * width + x0] * (1 - fx) + data[y0 * width + x1] * fx;
            const bottom = data[y1 * width + x0] * (1 - fx) + data[y1 * width + x1] * fx;
            out[y * outW + x] = Math.round(top * (1 - fy) + bottom * fy);
        }
    }
    return { data: out, width: outW, height: outH };
}

/** Flattens the quadrilateral `quad` to an upright rectangle. Output size comes from the quad's own side lengths. */
function flatten(gray, quad) {
    const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    let w = Math.round(Math.max(d(quad[0], quad[1]), d(quad[3], quad[2])));
    let h = Math.round(Math.max(d(quad[0], quad[3]), d(quad[1], quad[2])));
    const scale = Math.min(1, WORK_SIDE / Math.max(w, h));
    w = Math.max(2, Math.round(w * scale)); h = Math.max(2, Math.round(h * scale));
    const rect = [[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]];
    return warp(gray, solveHomography(rect, quad), w, h);          // output rectangle -> source quad
}

/** Estimated tilt in degrees (positive = clockwise) from how sharply text lines separate into rows. 0 if no clear answer. */
function estimateSkew(gray, maxDeg = 10, stepDeg = 0.25) {
    const scale = Math.min(1, 500 / Math.max(gray.width, gray.height));
    const w = Math.max(8, Math.round(gray.width * scale)); const h = Math.max(8, Math.round(gray.height * scale));
    const small = warp(gray, [1 / scale, 0, 0, 0, 1 / scale, 0, 0, 0, 1], w, h);
    const t = otsu(small.data);
    const ink = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (small.data[y * w + x] < t) ink.push([x - w / 2, y - h / 2]);
    if (ink.length < 50) return 0;
    let best = 0; let bestScore = -1; let zeroScore = 0;
    for (let a = -maxDeg; a <= maxDeg + 1e-9; a += stepDeg) {
        const rad = (a * Math.PI) / 180; const c = Math.cos(rad); const s = Math.sin(rad);
        const rows = new Float64Array(h * 2 + 4);
        for (const [x, y] of ink) rows[Math.round(-x * s + y * c + h)]++;      // row of this ink pixel after rotating by a
        let score = 0;
        for (let i = 1; i < rows.length; i++) score += (rows[i] - rows[i - 1]) ** 2;   // sharp row edges = straight text lines
        if (Math.abs(a) < 1e-9) zeroScore = score;
        if (score > bestScore) { bestScore = score; best = a; }
    }
    return bestScore > zeroScore * 1.05 ? best : 0;                            // only turn when clearly better than not turning
}

/** Rotates by `deg` degrees about the centre (positive = counter-clockwise result of a clockwise tilt). White fill. */
function rotate(gray, deg) {
    if (!deg) return gray;
    const rad = (deg * Math.PI) / 180; const c = Math.cos(rad); const s = Math.sin(rad);
    const cx = gray.width / 2; const cy = gray.height / 2;
    // output (x, y) -> source: rotate about the centre by +deg
    const H = [c, -s, cx - c * cx + s * cy, s, c, cy - s * cx - c * cy, 0, 0, 1];
    return warp(gray, H, gray.width, gray.height);
}

/** Linear contrast stretch to the 1st..99th percentile, so dim and washed-out photos reach OCR with the same tonal range. */
function stretchContrast(gray) {
    const hist = new Array(256).fill(0);
    for (const v of gray.data) hist[v]++;
    const n = gray.data.length;
    let lo = 0; let hi = 255; let acc = 0;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= n * 0.01) { lo = i; break; } }
    acc = 0;
    for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc >= n * 0.01) { hi = i; break; } }
    if (hi - lo < 20) return gray;                                          // nearly flat: nothing sensible to stretch
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = Math.max(0, Math.min(255, Math.round(((gray.data[i] - lo) * 255) / (hi - lo))));
    return { data: out, width: gray.width, height: gray.height };
}

/** Paints the given regions (fractions of the page) white, so OCR sees nothing there. Returns a new image. */
function maskRegions(gray, regions = []) {
    if (!regions.length) return gray;
    const data = Uint8Array.from(gray.data);
    for (const r of regions) {
        const x0 = Math.max(0, Math.floor(r.x0 * gray.width)); const x1 = Math.min(gray.width, Math.ceil(r.x1 * gray.width));
        const y0 = Math.max(0, Math.floor(r.y0 * gray.height)); const y1 = Math.min(gray.height, Math.ceil(r.y1 * gray.height));
        for (let y = y0; y < y1; y++) data.fill(255, y * gray.width + x0, y * gray.width + x1);
    }
    return { data, width: gray.width, height: gray.height };
}

/**
 * Full pipeline: any image -> flat, upright, contrast-normalised greyscale PNG ready for OCR.
 * @param {Buffer} input
 * @param {{ignoreRegions?: Array<{x0,y0,x1,y1}>}} [options]  areas of the page that are not text (see extract.js TEMPLATE)
 * @returns {Promise<{png: Buffer, steps: {flattened: boolean, skewDegrees: number}}>}
 */
async function prepareForOcr(input, { ignoreRegions = [] } = {}) {
    let page = await loadGray(input);
    const steps = { flattened: false, skewDegrees: 0 };
    const corners = findPageCorners(page);
    if (corners) { page = flatten(page, corners); steps.flattened = true; }
    const skew = estimateSkew(page);
    if (skew) { page = rotate(page, skew); steps.skewDegrees = skew; }
    // mask AFTER the stretch: painting white first would dominate the tonal range and leave a dim page's paper grey
    page = maskRegions(stretchContrast(page), ignoreRegions);
    // Tesseract reads best when text is at least ~20 px tall: scale small pages up to a working width
    // (A median denoise was tried and removed: on this template it made angled photos LESS readable.)
    const png = await sharp(Buffer.from(page.data), { raw: { width: page.width, height: page.height, channels: 1 } })
        .resize({ width: Math.max(page.width, 1200), withoutEnlargement: false }).png().toBuffer();
    return { png, steps };
}

module.exports = {
    loadGray, otsu, findPageCorners, solveHomography, applyH, warp, flatten, estimateSkew, rotate, stretchContrast, maskRegions, prepareForOcr,
    largestBlob, closeMask, polygonArea, borderBrightShare, WORK_SIDE,
};
