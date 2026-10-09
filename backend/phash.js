// Tier 3: perceptual hash and a 4x4 region grid. ADVISORY ONLY.
//
// A perceptual hash answers "does this LOOK like the anchored picture?". It cannot answer "is this the same document":
// every certificate of one template looks nearly alike, so a different person's card lands close to yours. So nothing in
// this file can approve a document. The strongest thing it can say is "consistent", and the useful thing it can say is
// "this one region changed while the rest did not" (a photo swap), which is a reason for a human to look.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { hammingHex } = require('./forensics');
const { flatPage } = require('./imaging');

const N = 32;                         // the picture is shrunk to N x N before the DCT
const LOW = 8;                        // the top-left 8 x 8 DCT coefficients (the coarse shape) make the 64 bits
const PAGE_W = 800;                   // every page is normalised to this size before gridding, so cells line up between captures
const PAGE_H = 560;
const GRID = 4;
// A cell whose SHRUNK picture (the 32 x 32 that is actually hashed) varies less than this has no structure to hash. Judged after
// shrinking because sensor noise averages out there: a blank tile of a dim, noisy photo measures 6 at full size but 3 shrunk, while the
// faintest real tile measures 14. (At full size and a limit of 3, such a tile counted as content and read as maximally different from
// the blank tile it came from: found by the forgery corpus, sample A4.)
const FLAT_STDEV = 8;
const MAX_DISTANCE = 64;

const THRESHOLDS_PATH = path.join(__dirname, 'config', 'tier3.json');

/** Thresholds live in config/tier3.json, not in code, so they can be re-measured without a code change. */
function loadThresholds(file = THRESHOLDS_PATH) {
    const t = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const k of ['cellFar', 'regionFar', 'wholeFar', 'maxLocalisedCells']) {
        if (!Number.isFinite(t[k]) || t[k] < 0) throw new Error(`tier3 config: ${k} must be a non-negative number`);
    }
    if (t.regionStableMax !== undefined && (!Number.isFinite(t.regionStableMax) || t.regionStableMax < 0)) {
        throw new Error('tier3 config: regionStableMax must be a non-negative number');
    }
    return t;
}

// ---- the DCT ------------------------------------------------------------------------------------------------------
const COS = (() => {
    const t = new Float64Array(N * N);
    for (let u = 0; u < N; u++) for (let x = 0; x < N; x++) t[u * N + x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N));
    return t;
})();

/** 2-D DCT-II of an N x N block (row-major), unnormalised. Separable: rows, then columns. */
function dct2d(block) {
    const tmp = new Float64Array(N * N);
    const out = new Float64Array(N * N);
    for (let y = 0; y < N; y++) for (let u = 0; u < N; u++) { let s = 0; for (let x = 0; x < N; x++) s += block[y * N + x] * COS[u * N + x]; tmp[y * N + u] = s; }
    for (let u = 0; u < N; u++) for (let v = 0; v < N; v++) { let s = 0; for (let y = 0; y < N; y++) s += tmp[y * N + u] * COS[v * N + y]; out[v * N + u] = s; }
    return out;
}

/** Shrinks greyscale pixels {data,width,height} to w x h (area-aware, Lanczos). */
async function resizeGray(gray, w, h) {
    const { data, info } = await sharp(Buffer.from(gray.data), { raw: { width: gray.width, height: gray.height, channels: 1 } })
        .resize(w, h, { fit: 'fill', kernel: 'lanczos3' }).greyscale().raw().toBuffer({ resolveWithObject: true });
    // sharp can hand back more than one channel; reading that as one channel per pixel scrambles the picture silently
    if (info.channels !== 1 || data.length !== w * h) throw new Error(`resizeGray: expected ${w}x${h} single-channel pixels, got ${info.channels} channel(s), ${data.length} bytes`);
    return { data: new Uint8Array(data), width: w, height: h };
}

/** Which pixels of a (sub)picture, in 0..255, vary at all? Used to recognise blank cells. */
function stdev(data) {
    let sum = 0;
    for (const v of data) sum += v;
    const mean = sum / data.length;
    let sq = 0;
    for (const v of data) sq += (v - mean) ** 2;
    return Math.sqrt(sq / data.length);
}

const toHex = (bits) => {
    let hex = '';
    for (let i = 0; i < 64; i += 4) hex += ((bits[i] << 3) | (bits[i + 1] << 2) | (bits[i + 2] << 1) | bits[i + 3]).toString(16);
    return hex;
};

/**
 * 64-bit perceptual hash of a greyscale picture, as 16 hex characters. Each of the 64 low-frequency DCT coefficients becomes
 * one bit: above the median of the 63 non-DC coefficients or not (the DC term, overall brightness, is fixed to 0 so that
 * lighting does not matter).
 * @returns {Promise<{h: string, flat: boolean}>} flat: the picture is uniform, so there is nothing to hash. Its h is all zeros.
 */
async function phash(gray) {
    const blank = { h: '0'.repeat(16), flat: true };
    if (stdev(gray.data) < 1) return blank;                       // perfectly uniform: no need to shrink it to know
    const small = await resizeGray(gray, N, N);
    if (stdev(small.data) < FLAT_STDEV) return blank;
    const coef = dct2d(Float64Array.from(small.data));
    const low = [];
    for (let v = 0; v < LOW; v++) for (let u = 0; u < LOW; u++) low.push(coef[v * N + u]);
    const ac = low.slice(1).sort((a, b) => a - b);
    const median = ac[(ac.length - 1) >> 1];
    const bits = low.map((c, i) => (i === 0 ? 0 : c > median ? 1 : 0));
    return { h: toHex(bits), flat: false };
}

/** Distance between two cell hashes: Hamming distance, except that a blank cell against a non-blank one is maximally different. */
function cellDistance(a, b) {
    if (a.flat && b.flat) return 0;
    if (a.flat !== b.flat) return MAX_DISTANCE;
    return hammingHex(a.h, b.h);
}

/** Cuts a page into rows x cols tiles, each hashed on its own. @returns {Promise<Array<Array<{h, flat}>>>} */
async function regionGrid(page, rows = GRID, cols = GRID) {
    const grid = [];
    for (let r = 0; r < rows; r++) {
        const line = [];
        for (let c = 0; c < cols; c++) {
            const x0 = Math.floor((c * page.width) / cols); const x1 = Math.floor(((c + 1) * page.width) / cols);
            const y0 = Math.floor((r * page.height) / rows); const y1 = Math.floor(((r + 1) * page.height) / rows);
            const tile = new Uint8Array((x1 - x0) * (y1 - y0));
            for (let y = y0; y < y1; y++) tile.set(page.data.subarray(y * page.width + x0, y * page.width + x1), (y - y0) * (x1 - x0));
            line.push(await phash({ data: tile, width: x1 - x0, height: y1 - y0 }));
        }
        grid.push(line);
    }
    return grid;
}

/** Hashes the part of the page inside `region` (fractions of the normalised page: x0, y0, x1, y1) on its own. */
async function regionHash(page, region) {
    const x0 = Math.max(0, Math.round(region.x0 * page.width)); const x1 = Math.min(page.width, Math.round(region.x1 * page.width));
    const y0 = Math.max(0, Math.round(region.y0 * page.height)); const y1 = Math.min(page.height, Math.round(region.y1 * page.height));
    const w = x1 - x0; const h = y1 - y0;
    if (w < 2 || h < 2) throw new Error('region is empty');
    const tile = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) tile.set(page.data.subarray((y0 + y) * page.width + x0, (y0 + y) * page.width + x1), y * w);
    const region_ = { data: tile, width: w, height: h };
    const hash = await phash(region_);
    return { ...hash, stability: await regionStability(region_, hash) };
}

/**
 * How far does this region's own hash move under ordinary re-capture (JPEG, a half-size copy, a little blur)? The largest Hamming
 * distance seen, 0..64. A textured photograph barely moves (0-6 measured). A flat graphic with hard edges (a cartoon portrait, a seal)
 * moves a LOT (28-30 measured), as much as a different picture would: its hash cannot tell a copy from a substitution, so a region
 * like that must not be judged at all. Measured once, when the document is issued, and stored with the hash.
 */
async function regionStability(region, hash) {
    if (hash.flat) return 0;
    const { data, width, height } = region;
    const source = () => sharp(Buffer.from(data), { raw: { width, height, channels: 1 } });
    const restore = async (encoded) => {
        const { data: out, info } = await sharp(encoded).greyscale().resize(width, height, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
        if (info.channels !== 1 || out.length !== width * height) throw new Error('regionStability: unexpected pixel layout');
        return { data: new Uint8Array(out), width, height };
    };
    const variants = [
        () => source().jpeg({ quality: 60 }).toBuffer(),
        () => source().resize(Math.max(8, Math.round(width / 2))).jpeg({ quality: 70 }).toBuffer(),
        () => source().blur(1).png().toBuffer(),
    ];
    let worst = 0;
    for (const encode of variants) worst = Math.max(worst, cellDistance(hash, await phash(await restore(await encode()))));
    return worst;
}

/**
 * Reads the look of a document image: flatten, straighten and crop it to its printed content exactly as Tier 2 does, scale it
 * to a fixed page size, then hash the whole page, each of its 16 tiles, and any named regions the template defines (the photo).
 * @param {Buffer} image
 * @param {{regions?: Object<string, {x0,y0,x1,y1}>}} [options]
 * @returns {Promise<{phash: {h, flat}, grid: Array<Array<{h, flat}>>, regions: Object<string, {h, flat}>, steps}>}
 */
async function analyseVisual(image, { regions = {} } = {}) {
    const { page, steps } = await flatPage(image);
    const fixed = await resizeGray(page, PAGE_W, PAGE_H);
    const named = {};
    for (const [name, box] of Object.entries(regions)) named[name] = await regionHash(fixed, box);
    return { phash: await phash(fixed), grid: await regionGrid(fixed), regions: named, steps };
}

/**
 * Compares a presented picture with the anchored one.
 * @returns {{advisory: true, distance, cells, diverged, regionDistances, changedRegions, pattern}}
 *   cells: Hamming distance of every tile; diverged: [row, col] of tiles above cellFar.
 *   regionDistances / changedRegions: the same for named regions (the photo), judged against regionFar.
 *   unreliableRegions: named regions whose hash was unstable when the document was issued (see regionStability); never judged.
 *   pattern CLOSE: nothing stands out.  LOCALISED: a few tiles and/or a named region changed while the rest held (a pasted-over
 *   photo looks like this).  GLOBAL: many tiles differ (a very different capture, crop or document): says little, and is never
 *   read as "just a re-capture, so fine".
 */
function compareVisual(anchored, presented, thresholds = loadThresholds()) {
    const cells = anchored.grid.map((row, r) => row.map((cell, c) => cellDistance(cell, presented.grid[r][c])));
    const diverged = [];
    cells.forEach((row, r) => row.forEach((d, c) => { if (d > thresholds.cellFar) diverged.push([r, c]); }));
    const regionDistances = {};
    for (const [name, anchoredHash] of Object.entries(anchored.regions || {})) {
        regionDistances[name] = presented.regions && presented.regions[name] ? cellDistance(anchoredHash, presented.regions[name]) : MAX_DISTANCE;
    }
    // a region whose own hash is not stable under ordinary re-capture cannot tell a copy from a substitution: say so, and do not judge it
    const stableMax = thresholds.regionStableMax === undefined ? Infinity : thresholds.regionStableMax;
    const unreliableRegions = Object.keys(regionDistances).filter((n) => Number.isFinite(anchored.regions[n].stability) && anchored.regions[n].stability > stableMax);
    const changedRegions = Object.keys(regionDistances).filter((n) => regionDistances[n] > thresholds.regionFar && !unreliableRegions.includes(n));
    const distance = cellDistance(anchored.phash, presented.phash);
    let pattern = 'CLOSE';
    if (diverged.length > thresholds.maxLocalisedCells) pattern = 'GLOBAL';
    else if (diverged.length > 0 || changedRegions.length > 0) pattern = 'LOCALISED';
    return { advisory: true, distance, cells, diverged, regionDistances, changedRegions, unreliableRegions, pattern, wholeFar: distance > thresholds.wholeFar };
}

/**
 * What a human should be told. There is deliberately no "approved" answer: Tier 3 can only agree with Tier 2 or ask for a look.
 * @returns {'CONSISTENT'|'REVIEW'|'UNCLEAR'}
 */
function advice(result) {
    if (result.pattern === 'LOCALISED') return 'REVIEW';
    if (result.pattern === 'GLOBAL') return 'UNCLEAR';
    return 'CONSISTENT';
}

module.exports = {
    phash, regionGrid, regionHash, analyseVisual, compareVisual, advice, cellDistance, loadThresholds, dct2d, resizeGray, regionStability,
    N, LOW, GRID, PAGE_W, PAGE_H, FLAT_STDEV, MAX_DISTANCE, THRESHOLDS_PATH,
};
