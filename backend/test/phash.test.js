// Issue #65, Tier 3: perceptual hash and the region grid. Advisory only.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const ph = require('../phash');
const { hammingHex } = require('../forensics');
const { TEMPLATE } = require('../extract');
const c = require('./fixtures/certificate');
const { measure, classify } = require('../scripts/calibrate-tier3');

const T = ph.loadThresholds();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 't3-'));   // config files written by tests; removed afterwards
const OPTIONS = { regions: { photo: TEMPLATE.photoRegion } };
const gray = (w, h, fn) => { const data = new Uint8Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = fn(x, y); return { data, width: w, height: h }; };
const seeded = (seed) => { let s = seed; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; };
const texture = (seed, w = 200, h = 140) => { const r = seeded(seed); return gray(w, h, () => Math.floor(r() * 256)); };

// ---------------------------------------------------------------- the DCT
test('dct2d: a constant block has only the DC term; a single cosine lands on exactly one coefficient', () => {
    const N = ph.N;
    const flatBlock = ph.dct2d(new Float64Array(N * N).fill(100));
    assert.ok(Math.abs(flatBlock[0] - 100 * N * N) < 1e-6);
    assert.ok(flatBlock.slice(1).every((v) => Math.abs(v) < 1e-6), 'no other coefficient');
    const wave = new Float64Array(N * N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) wave[y * N + x] = Math.cos(((2 * x + 1) * 3 * Math.PI) / (2 * N));   // frequency 3 across x
    const out = ph.dct2d(wave);
    const big = [...out].map((v, i) => [Math.abs(v), i]).filter(([v]) => v > 1e-6);
    assert.strictEqual(big.length, 1);
    assert.strictEqual(big[0][1], 0 * N + 3, 'row 0, column 3');
});

test('dct2d matches the textbook formula on a random block', () => {
    const N = ph.N; const r = seeded(5);
    const block = Float64Array.from({ length: N * N }, () => r() * 255);
    const fast = ph.dct2d(block);
    for (const [u, v] of [[0, 0], [1, 0], [0, 2], [5, 3], [7, 7]]) {
        let sum = 0;
        for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) sum += block[y * N + x] * Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N)) * Math.cos(((2 * y + 1) * v * Math.PI) / (2 * N));
        assert.ok(Math.abs(fast[v * N + u] - sum) < 1e-6, `coefficient (${u},${v})`);
    }
});

// ---------------------------------------------------------------- the hash
test('phash is 16 hex characters, deterministic, and blind to brightness and contrast changes', async () => {
    const img = texture(1);
    const a = await ph.phash(img);
    assert.match(a.h, /^[0-9a-f]{16}$/);
    assert.deepStrictEqual(await ph.phash(img), a);
    const brighter = { ...img, data: img.data.map((v) => Math.min(255, v * 0.5 + 100)) };    // lower contrast, lifted brightness
    assert.ok(hammingHex(a.h, (await ph.phash(brighter)).h) <= 4);
});

test('phash: a slightly changed picture stays close, an unrelated one lands far away (about half the bits)', async () => {
    const base = texture(1);
    const noisy = { ...base, data: base.data.map((v, i) => Math.max(0, Math.min(255, v + ((i * 7919) % 9) - 4))) };
    const close = hammingHex((await ph.phash(base)).h, (await ph.phash(noisy)).h);
    assert.ok(close <= 6, `close ${close}`);
    const far = [];
    for (const seed of [2, 3, 4, 5, 6]) far.push(hammingHex((await ph.phash(base)).h, (await ph.phash(texture(seed))).h));
    assert.ok(far.every((d) => d >= 14), `unrelated pictures: ${far}`);
});

test('a uniform picture is "flat": nothing to hash, so it is never compared on noise', async () => {
    const white = gray(200, 140, () => 255);
    const speckled = gray(200, 140, (x, y) => (x === 3 && y === 4 ? 250 : 255));                // a trace of dust
    const a = await ph.phash(white);
    assert.deepStrictEqual(a, { h: '0'.repeat(16), flat: true });
    assert.strictEqual((await ph.phash(speckled)).flat, true);
    assert.strictEqual(ph.cellDistance(a, await ph.phash(speckled)), 0, 'blank against blank is identical');
    const textured = await ph.phash(texture(1));
    assert.strictEqual(textured.flat, false);
    assert.strictEqual(ph.cellDistance(a, textured), ph.MAX_DISTANCE, 'blank against content is as different as it gets');
});

test('regionGrid cuts a page into 16 tiles, each hashed on its own; tile edges line up for any page size', async () => {
    const grid = await ph.regionGrid(texture(9, 801, 563));
    assert.strictEqual(grid.length, 4);
    assert.ok(grid.every((row) => row.length === 4));
    const hashes = new Set(grid.flat().map((cell) => cell.h));
    assert.ok(hashes.size >= 14, 'different content in each tile gives different hashes');
    const wide = await ph.regionGrid(texture(9, 400, 100), 2, 8);
    assert.strictEqual(wide.length, 2);
    assert.strictEqual(wide[0].length, 8);
});

test('regionHash: hashes just the named part of the page, and refuses an empty region', async () => {
    const page = gray(400, 300, (x, y) => (x > 250 && y < 100 ? (x * 7 + y * 13) % 256 : 255));
    const inside = await ph.regionHash(page, { x0: 0.65, y0: 0, x1: 1, y1: 0.33 });
    assert.strictEqual(inside.flat, false);
    assert.strictEqual((await ph.regionHash(page, { x0: 0, y0: 0.5, x1: 0.5, y1: 1 })).flat, true, 'the blank corner');
    await assert.rejects(() => ph.regionHash(page, { x0: 0.5, y0: 0.5, x1: 0.5, y1: 0.5 }), /empty/);
});

test('resizeGray refuses to hand back scrambled pixels (the multi-channel bug that corrupted the first measurements)', async () => {
    const out = await ph.resizeGray(texture(3, 100, 80), 32, 32);
    assert.strictEqual(out.data.length, 32 * 32);
    assert.strictEqual(out.width, 32);
});

// ---------------------------------------------------------------- thresholds live in config
test('thresholds come from config/tier3.json and are validated', () => {
    for (const k of ['cellFar', 'regionFar', 'wholeFar', 'maxLocalisedCells']) assert.ok(Number.isFinite(T[k]) && T[k] >= 0, k);
    assert.ok(T.regionFar > T.calibration.reCapturePhotoRegionLargest, 'the region threshold sits above what ordinary captures reach');
    assert.ok(T.cellFar > T.calibration.reCaptureLargestTile, 'the tile threshold sits above what ordinary captures reach');
    assert.match(T.calibration.data, /SIMULATED/, 'the config says where its numbers came from');
    const dir = scratch;
    const write = (obj) => { const f = path.join(dir, 'c.json'); fs.writeFileSync(f, JSON.stringify(obj)); return f; };
    assert.throws(() => ph.loadThresholds(write({ cellFar: 12, regionFar: 16, wholeFar: 8 })), /maxLocalisedCells/);
    assert.throws(() => ph.loadThresholds(write({ cellFar: -1, regionFar: 16, wholeFar: 8, maxLocalisedCells: 2 })), /cellFar/);
    assert.throws(() => ph.loadThresholds(write({ cellFar: '12', regionFar: 16, wholeFar: 8, maxLocalisedCells: 2 })), /cellFar/);
    assert.throws(() => ph.loadThresholds(path.join(dir, 'missing.json')));
});

// ---------------------------------------------------------------- comparing
const flatCell = { h: '0'.repeat(16), flat: true };
const gridOf = (hex) => Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => ({ h: hex, flat: false })));
const anchored = { phash: { h: 'aaaaaaaaaaaaaaaa', flat: false }, grid: gridOf('aaaaaaaaaaaaaaaa'), regions: { photo: { h: 'aaaaaaaaaaaaaaaa', flat: false } } };
const change = (grid, r, cc, hex) => grid.map((row, i) => row.map((cell, j) => (i === r && j === cc ? { h: hex, flat: false } : cell)));
const FAR = 'a5a5a5a5a5a5a5a5';        // 32 bits away from 'aaaa...'

test('compareVisual: identical gives CLOSE and CONSISTENT', () => {
    const r = ph.compareVisual(anchored, anchored, T);
    assert.deepStrictEqual([r.pattern, r.diverged.length, r.changedRegions.length, r.distance], ['CLOSE', 0, 0, 0]);
    assert.strictEqual(ph.advice(r), 'CONSISTENT');
});

test('compareVisual: one tile far while the rest stay tight is LOCALISED, naming the tile; advice is REVIEW', () => {
    const presented = { ...anchored, grid: change(anchored.grid, 1, 3, FAR) };
    const r = ph.compareVisual(anchored, presented, T);
    assert.strictEqual(r.pattern, 'LOCALISED');
    assert.deepStrictEqual(r.diverged, [[1, 3]]);
    assert.strictEqual(r.cells[1][3], 32);
    assert.strictEqual(ph.advice(r), 'REVIEW');
});

test('compareVisual: only the named photo region changed is LOCALISED too', () => {
    const r = ph.compareVisual(anchored, { ...anchored, regions: { photo: { h: FAR, flat: false } } }, T);
    assert.deepStrictEqual([r.pattern, r.changedRegions, r.diverged.length], ['LOCALISED', ['photo'], 0]);
    assert.strictEqual(ph.advice(r), 'REVIEW');
});

test('compareVisual: many tiles far is GLOBAL (a bad capture or another document), and says "unclear", never "fine"', () => {
    let grid = anchored.grid;
    for (const [r, cc] of [[0, 0], [1, 1], [2, 2], [3, 3]]) grid = change(grid, r, cc, FAR);
    const r = ph.compareVisual(anchored, { ...anchored, grid, regions: { photo: { h: FAR, flat: false } } }, T);
    assert.strictEqual(r.pattern, 'GLOBAL');
    assert.strictEqual(ph.advice(r), 'UNCLEAR');
});

test('compareVisual: the number of tiles that still counts as localised comes from the config', () => {
    let grid = anchored.grid;
    for (const [r, cc] of [[0, 0], [1, 1]]) grid = change(grid, r, cc, FAR);
    const two = ph.compareVisual(anchored, { ...anchored, grid }, T);
    assert.strictEqual(two.pattern, 'LOCALISED');
    assert.strictEqual(ph.compareVisual(anchored, { ...anchored, grid }, { ...T, maxLocalisedCells: 1 }).pattern, 'GLOBAL');
    assert.strictEqual(ph.compareVisual(anchored, { ...anchored, grid }, { ...T, cellFar: 40 }).pattern, 'CLOSE');
});

test('compareVisual: a missing region in the presented picture counts as maximally different, a blank tile against a busy one as well', () => {
    const noPhoto = ph.compareVisual(anchored, { ...anchored, regions: {} }, T);
    assert.strictEqual(noPhoto.regionDistances.photo, ph.MAX_DISTANCE);
    const blanked = ph.compareVisual(anchored, { ...anchored, grid: anchored.grid.map((row, i) => row.map((cell, j) => (i === 2 && j === 2 ? flatCell : cell))) }, T);
    assert.strictEqual(blanked.cells[2][2], ph.MAX_DISTANCE);
    assert.deepStrictEqual(blanked.diverged, [[2, 2]]);
});

test('ADVISORY ONLY: no result, advice or export can say "approved"', () => {
    assert.ok(Object.keys(ph).every((k) => !/approv|accept|authentic|verify/i.test(k)), 'no export that approves');
    const answers = new Set();
    for (const pattern of ['CLOSE', 'LOCALISED', 'GLOBAL']) answers.add(ph.advice({ pattern }));
    assert.deepStrictEqual([...answers].sort(), ['CONSISTENT', 'REVIEW', 'UNCLEAR']);
    assert.strictEqual(ph.compareVisual(anchored, anchored, T).advisory, true);
    assert.ok(![...answers].some((a) => /approv|authentic|valid/i.test(a)));
});

// ---------------------------------------------------------------- real certificates
const look = (png) => ph.analyseVisual(png, OPTIONS);

test('analyseVisual: hashes the page, 16 tiles and the photo; the same picture twice gives identical results', async () => {
    const png = await c.renderWithPhoto(11);
    const a = await look(png);
    assert.match(a.phash.h, /^[0-9a-f]{16}$/);
    assert.strictEqual(a.grid.flat().length, 16);
    assert.deepStrictEqual(Object.keys(a.regions), ['photo']);
    assert.deepStrictEqual(await look(png), a);
    assert.strictEqual(ph.compareVisual(a, await look(png), T).pattern, 'CLOSE');
});

test('a re-photographed copy is CONSISTENT: low distance in every tile and in the photo (JPEG, shrunk, rotated, angled)', async () => {
    const original = await look(await c.renderWithPhoto(11));
    for (const make of [c.jpeg(40), c.shrink(0.5), c.rotated(-4), c.angled([[160, 110], [1000, 170], [950, 800], [110, 740]])]) {
        const r = ph.compareVisual(original, await look(await make(await c.renderWithPhoto(11))), T);
        assert.strictEqual(ph.advice(r), 'CONSISTENT', `${JSON.stringify({ cells: r.cells, photo: r.regionDistances })}`);
        assert.ok(Math.max(...r.cells.flat()) <= T.cellFar);
        assert.ok(r.regionDistances.photo <= T.regionFar);
    }
});

test('a substituted photo is LOCALISED to the photo: the photo tile and the photo region move, every other tile stays put', async () => {
    const original = await look(await c.renderWithPhoto(11));
    for (const seed of [22, 44, 66]) {
        const r = ph.compareVisual(original, await look(await c.renderWithPhoto(seed)), T);
        assert.strictEqual(r.pattern, 'LOCALISED');
        assert.deepStrictEqual(r.changedRegions, ['photo']);
        assert.ok(r.diverged.every(([row, col]) => row === 1 && col === 3), `only the photo tile may diverge: ${JSON.stringify(r.diverged)}`);
        const others = r.cells.flat().filter((_, i) => i !== 1 * 4 + 3);
        assert.strictEqual(Math.max(...others), 0, 'nothing else on the page moved');
        assert.strictEqual(ph.advice(r), 'REVIEW');
    }
});

test('a substituted photo is still flagged when the forged copy is also compressed, shrunk and photographed', async () => {
    const original = await look(await c.renderWithPhoto(11));
    const forged = await c.renderWithPhoto(33);
    for (const make of [c.jpeg(40), c.pipe(c.shrink(0.6), c.jpeg(60)), c.angled([[160, 110], [1000, 170], [950, 800], [110, 740]])]) {
        assert.strictEqual(ph.advice(ph.compareVisual(original, await look(await make(forged)), T)), 'REVIEW');
    }
});

test('a region pasted over elsewhere on the page is LOCALISED to the tiles it touches, with the photo untouched', async () => {
    const original = await look(await c.renderWithPhoto(11));
    const png = await c.renderWithPhoto(11);
    const patch = await sharp({ create: { width: 330, height: 90, channels: 3, background: '#222' } }).png().toBuffer();
    const pasted = await sharp(png).composite([{ input: patch, left: 60, top: 440 }]).png().toBuffer();
    const r = ph.compareVisual(original, await look(pasted), T);
    assert.ok(r.diverged.length >= 1, 'something diverged');
    assert.deepStrictEqual(r.changedRegions, [], 'the photo did not');
    assert.notStrictEqual(ph.advice(r), 'CONSISTENT');
});

test('KNOWN BLIND SPOTS, measured: a different person on the same template and a changed date of birth look CONSISTENT, so Tier 3 can never approve or reject alone', async () => {
    const original = await look(await c.renderWithPhoto(11));
    const person = await look(await c.renderWithPhoto(11, c.withFields({ holder: 'Ravi Menon', idNumber: 'B210999EE' }, { dob: '03-09-2004', cgpa: '7.9' })));
    const dob = await look(await c.renderWithPhoto(11, c.withFields({}, { dob: '12-04-2003' })));
    assert.strictEqual(ph.advice(ph.compareVisual(original, person, T)), 'CONSISTENT');
    assert.strictEqual(ph.advice(ph.compareVisual(original, dob, T)), 'CONSISTENT');
});

test('a completely different document is not mistaken for a re-capture: it reads as UNCLEAR or REVIEW, never CONSISTENT', async () => {
    const original = await look(await c.renderWithPhoto(11));
    const blank = await sharp({ create: { width: 1000, height: 700, channels: 3, background: '#fff' } }).png().toBuffer();
    const noise = await sharp({ create: { width: 1000, height: 700, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 70 } } }).png().toBuffer();
    for (const other of [blank, noise]) assert.notStrictEqual(ph.advice(ph.compareVisual(original, await look(other), T)), 'CONSISTENT');
});

test('unusable input is an error, not a hash: broken bytes throw; a 1-pixel image does not crash', async () => {
    await assert.rejects(() => ph.analyseVisual(Buffer.from('not an image'), OPTIONS));
    const speck = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#000' } }).png().toBuffer();
    const r = await ph.analyseVisual(speck, {});
    assert.strictEqual(r.grid.length, 4);
});

test('EVIDENCE: at the committed thresholds every simulated re-capture is CONSISTENT and every one of 6 other photos is REVIEW', async (t) => {
    const m = await measure();
    const result = classify(m, T);
    t.diagnostic(JSON.stringify(result));
    assert.strictEqual(m.recaptures.length, T.calibration.reCaptures, 'the config records how many re-captures were measured');
    assert.deepStrictEqual(result.recaptures, { CONSISTENT: m.recaptures.length });
    assert.deepStrictEqual(result.swaps, { REVIEW: 6 });
    assert.strictEqual(Math.max(...m.recaptures.flatMap((r) => r.cells.flat())) <= T.calibration.reCaptureLargestTile, true, 'the config\'s recorded numbers are not stale');
    assert.strictEqual(Math.max(...m.recaptures.map((r) => r.regionDistances.photo)) <= T.calibration.reCapturePhotoRegionLargest, true);
    assert.ok(Math.min(...m.swaps.map((r) => r.regionDistances.photo)) >= 24, 'the smallest swap distance the config records');
});

after(() => { fs.rmSync(scratch, { recursive: true, force: true }); });

// ---------------------------------------------------------------- regions that cannot be judged
test('regionStability: a textured photo barely moves under re-capture; a flat hard-edged graphic moves as far as a different picture would', async () => {
    const textured = [];
    for (const seed of [11, 22, 33, 44, 55, 66]) textured.push((await look(await c.renderWithPhoto(seed))).regions.photo.stability);
    const flat = (await look(await c.render(c.DEFAULT_FIELDS))).regions.photo.stability;
    const flatB = (await look(await c.render(c.DEFAULT_FIELDS, { photoStyle: 'b' }))).regions.photo.stability;
    assert.ok(Math.max(...textured) <= T.regionStableMax, `textured photos: ${textured}`);
    assert.ok(flat > T.regionStableMax && flatB > T.regionStableMax, `flat portraits: ${flat}, ${flatB}`);
    assert.ok(T.regionStableMax < T.regionFar, 'a region must be steadier than the distance that counts as "changed"');
});

test('compareVisual: an unstable region is reported as unreliable and never judged, however far it is', () => {
    const unstable = { ...anchored, regions: { photo: { h: 'aaaaaaaaaaaaaaaa', flat: false, stability: 30 } } };
    const r = ph.compareVisual(unstable, { ...anchored, regions: { photo: { h: FAR, flat: false } } }, { ...T, regionStableMax: 12 });
    assert.deepStrictEqual([r.pattern, r.changedRegions, r.unreliableRegions, r.regionDistances.photo], ['CLOSE', [], ['photo'], 32]);
    assert.strictEqual(ph.advice(r), 'CONSISTENT');
});

test('compareVisual: a stable region is still judged; a record from before stability was measured behaves as it always did', () => {
    const presented = { ...anchored, regions: { photo: { h: FAR, flat: false } } };
    const stable = { ...anchored, regions: { photo: { h: 'aaaaaaaaaaaaaaaa', flat: false, stability: 4 } } };
    assert.deepStrictEqual(ph.compareVisual(stable, presented, { ...T, regionStableMax: 12 }).changedRegions, ['photo']);
    assert.deepStrictEqual(ph.compareVisual(anchored, presented, { ...T, regionStableMax: 12 }).changedRegions, ['photo']);   // no stability recorded
    assert.deepStrictEqual(ph.compareVisual(stable, presented, T).unreliableRegions, [] , 'no limit configured: nothing is excluded');
});

test('loadThresholds: regionStableMax is optional but must be a number when present', () => {
    const write = (o) => { const f = path.join(scratch, 't.json'); fs.writeFileSync(f, JSON.stringify(o)); return f; };
    const base = { cellFar: 12, regionFar: 16, wholeFar: 8, maxLocalisedCells: 2 };
    assert.strictEqual(ph.loadThresholds(write(base)).regionStableMax, undefined);
    assert.strictEqual(ph.loadThresholds(write({ ...base, regionStableMax: 12 })).regionStableMax, 12);
    assert.throws(() => ph.loadThresholds(write({ ...base, regionStableMax: 'x' })), /regionStableMax/);
    assert.throws(() => ph.loadThresholds(write({ ...base, regionStableMax: -1 })), /regionStableMax/);
});
