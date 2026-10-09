// Issue #52: flattening and straightening photos of documents. Synthetic pages with known geometry, no OCR.
const test = require('node:test');
const assert = require('node:assert');
const sharp = require('sharp');
const im = require('../imaging');
const { photographed, toPng } = require('./fixtures/photo');

/** A white page with rows of black "text" bars (deterministic). */
function makePage(w = 600, h = 420) {
    const data = new Uint8Array(w * h).fill(255);
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let y = 40; y < h - 40; y += 28) {
        const len = 150 + Math.floor(rnd() * 300);
        for (let yy = y; yy < y + 8; yy++) for (let x = 50; x < 50 + len && x < w - 40; x++) data[yy * w + x] = 0;
    }
    return { data, width: w, height: h };
}

const near = (a, b, tol) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol;
const QUAD = [[130, 90], [760, 140], [720, 610], [90, 560]];     // a page seen at an angle

function correlation(a, b) {
    let sa = 0; let sb = 0;
    for (let i = 0; i < a.length; i++) { sa += a[i]; sb += b[i]; }
    const ma = sa / a.length; const mb = sb / b.length;
    let num = 0; let da = 0; let db = 0;
    for (let i = 0; i < a.length; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
    return num / Math.sqrt(da * db);
}

test('otsu finds the gap between a dark and a bright population', () => {
    const data = new Uint8Array(2000);
    for (let i = 0; i < 1000; i++) data[i] = 30 + (i % 20);
    for (let i = 1000; i < 2000; i++) data[i] = 200 + (i % 30);
    const t = im.otsu(data);
    assert.ok(t >= 49 && t < 200, `threshold ${t}`);
});

test('solveHomography maps the four source points exactly onto the four destination points', () => {
    const src = [[0, 0], [100, 0], [100, 60], [0, 60]];
    const dst = [[12, 8], [210, 30], [190, 150], [4, 120]];
    const H = im.solveHomography(src, dst);
    src.forEach((p, i) => assert.ok(near(im.applyH(H, ...p), dst[i], 1e-6)));
    const I = im.solveHomography(src, src);
    assert.ok(near(im.applyH(I, 33, 21), [33, 21], 1e-6), 'identity case');
    assert.throws(() => im.solveHomography([[0, 0], [0, 0], [1, 1], [2, 2]], dst), /degenerate/);
});

test('findPageCorners finds the page in a tilted photo to within a few pixels', () => {
    const photo = photographed(makePage(), QUAD);
    const found = im.findPageCorners(photo);
    assert.ok(found, 'a page was found');
    found.forEach((p, i) => assert.ok(near(p, QUAD[i], 8), `corner ${i}: found ${p}, expected ${QUAD[i]}`));
});

test('findPageCorners finds nothing when the picture already is the page, or there is no page', () => {
    assert.strictEqual(im.findPageCorners(makePage()), null, 'a full-frame page needs no flattening');
    assert.strictEqual(im.findPageCorners({ data: new Uint8Array(300 * 300).fill(120), width: 300, height: 300 }), null);
    const dark = { data: new Uint8Array(300 * 300).fill(30), width: 300, height: 300 };
    assert.strictEqual(im.findPageCorners(dark), null);
    const tiny = photographed(makePage(60, 40), [[400, 300], [470, 305], [468, 350], [398, 346]]);
    assert.strictEqual(im.findPageCorners(tiny), null, 'a speck is not a page');
});

test('flatten turns the tilted photo back into the upright page (high correlation with the original)', () => {
    const page = makePage();
    const photo = photographed(page, QUAD);
    const flat = im.flatten(photo, im.findPageCorners(photo));
    const original = im.warp(page, [page.width / flat.width, 0, 0, 0, page.height / flat.height, 0, 0, 0, 1], flat.width, flat.height);
    const r = correlation(flat.data, original.data);
    assert.ok(r > 0.85, `correlation ${r.toFixed(3)}`);
    assert.ok(Math.abs(flat.width / flat.height - page.width / page.height) < 0.2, 'aspect ratio is restored approximately');
});

test('estimateSkew finds a small tilt, turning by it straightens the page, and an upright page is left alone', () => {
    const page = makePage();
    assert.strictEqual(im.estimateSkew(page), 0, 'upright page');
    for (const tilt of [-6, -3, 2, 4, 7]) {
        const tilted = im.rotate(page, tilt);
        const est = im.estimateSkew(tilted);
        const fixed = im.rotate(tilted, est);
        assert.ok(Math.abs(im.estimateSkew(fixed)) <= 0.75, `tilt ${tilt}: estimated ${est}, left over ${im.estimateSkew(fixed)}`);
        assert.ok(Math.abs(est) >= Math.abs(tilt) - 1 && Math.abs(est) <= Math.abs(tilt) + 1, `tilt ${tilt}: estimated ${est}`);
    }
});

test('stretchContrast restores the tonal range of a dim, washed-out photo and leaves a flat image alone', () => {
    const dim = { data: Uint8Array.from({ length: 1000 }, (_, i) => 100 + (i % 41)), width: 1000, height: 1 };
    const out = im.stretchContrast(dim);
    assert.ok(Math.min(...out.data) <= 5 && Math.max(...out.data) >= 250);
    const flat = { data: new Uint8Array(100).fill(128), width: 100, height: 1 };
    assert.strictEqual(im.stretchContrast(flat), flat);
});

test('prepareForOcr: a tilted photo is flattened; an upright page is not touched; both come back as PNG', async () => {
    const page = makePage();
    const angled = await im.prepareForOcr(await toPng(photographed(page, QUAD)));
    assert.strictEqual(angled.steps.flattened, true);
    assert.strictEqual((await sharp(angled.png).metadata()).format, 'png');
    const upright = await im.prepareForOcr(await toPng(page));
    assert.strictEqual(upright.steps.flattened, false);
    assert.strictEqual(upright.steps.skewDegrees, 0);
});

test('prepareForOcr refuses garbage with an error instead of crashing the process', async () => {
    await assert.rejects(() => im.prepareForOcr(Buffer.from('this is not an image')));
});
