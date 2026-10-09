// Issue #74: the forgery corpus, as a measurement. Every sample's verdict, and the fields or region it must name, comes from
// corpus/manifest.json and is judged by the REAL pipeline (real MongoDB, real OCR, real perceptual hashing, the real routes).
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { runCorpus, formatReport, readManifest, CORPUS_DIR } = require('./corpus-runner');
const { shutdown } = require('../ocr');
const { VERDICTS } = require('../forensics');
const c = require('./fixtures/certificate');

const manifest = readManifest();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-'));
after(async () => { await shutdown(); fs.rmSync(scratch, { recursive: true, force: true }); });

// ---------------------------------------------------------------- the corpus itself
test('the manifest describes exactly the files that are there, and says what each is and what must happen to it', () => {
    const onDisk = fs.readdirSync(path.join(CORPUS_DIR, 'files')).sort();
    assert.deepStrictEqual(manifest.samples.map((s) => s.file).sort(), onDisk);
    assert.strictEqual(manifest.samples.length, 14);
    for (const s of manifest.samples) {
        const bytes = fs.readFileSync(path.join(CORPUS_DIR, 'files', s.file));
        assert.strictEqual(crypto.createHash('sha256').update(bytes).digest('hex'), s.sha256, `${s.file} was edited after it was generated`);
        assert.ok(['genuine', 'tampered', 'negative'].includes(s.group), s.file);
        assert.ok(VERDICTS.includes(s.expectedVerdict), `${s.file}: ${s.expectedVerdict}`);
        assert.strictEqual(typeof s.simulated, 'boolean', s.file);
        assert.ok(s.derivation && s.derivation.length > 20, `${s.file} says how it was made`);
        if (s.group === 'tampered') {
            assert.ok(['L1', 'L2', 'L3'].includes(s.severity), s.file);
            assert.ok(s.manipulation, s.file);
            assert.ok(s.tamperedFields || s.tamperedRegions || s.note, `${s.file} names what was altered, or says why not`);
        }
    }
    assert.deepStrictEqual(['genuine', 'tampered', 'negative'].map((g) => manifest.samples.filter((s) => s.group === g).length), [5, 6, 3]);
});

test('SYNTHETIC ONLY: fictional authority and people, no ID in any real scheme, every digital file marked SPECIMEN', async () => {
    const text = JSON.stringify(manifest);
    assert.match(manifest.specimenText, /^SPECIMEN .* NOT A VALID DOCUMENT .* GENERATED FOR TESTING$/);
    assert.match(manifest.anchoredFields.issuer, /Testland/);
    assert.ok(manifest.samples.every((s) => s.synthetic === true));
    assert.ok(!/\b\d{12}\b/.test(text) && !/\b\d{4}[ -]\d{4}[ -]\d{4}\b/.test(text), 'no 12-digit (Aadhaar-shaped) number anywhere');
    assert.match(manifest.anchoredFields.idNumber, /^T\d{6}TS$/, 'IDs use a reserved test shape');
    // the marking is printed, in pale grey, on the foot of every digital file
    for (const s of manifest.samples.filter((x) => !x.simulated)) {
        const { data, info } = await sharp(path.join(CORPUS_DIR, 'files', s.file)).extract({ left: 200, top: c.H - 34, width: 600, height: 24 }).greyscale().raw().toBuffer({ resolveWithObject: true });
        const grey = [...data].filter((v) => v > 120 && v < 215).length;
        assert.ok(grey > 100, `${s.file} carries the SPECIMEN marking (${grey} pixels of pale print in the foot band of ${info.width}x${info.height})`);
    }
});

// ---------------------------------------------------------------- the measurement
test('EVIDENCE: every sample gets the verdict the manifest expects, with the right fields named and the right region flagged', async () => {
    const report = await runCorpus();
    const failed = report.results.filter((r) => !r.ok);
    console.log(`\n${formatReport(report)}\n`);
    assert.deepStrictEqual(failed.map((r) => `${r.file}: ${r.checks.filter((k) => !k.ok).map((k) => k.detail).join('; ')}`), []);
    const by = (g) => report.results.filter((r) => r.group === g && r.ok).length;
    assert.deepStrictEqual([by('genuine'), by('tampered'), by('negative')], [5, 6, 3]);
    // the four things the corpus exists to prove
    const verdict = (f) => report.results.find((r) => r.file === f).actual;
    assert.strictEqual(verdict('C1_different_person.png'), 'NOT_REGISTERED', 'a different person with the same photo and template is NOT rescued by visual similarity');
    assert.strictEqual(verdict('B3_photo_swap.png'), 'TAMPERED_VISUAL', 'only the appearance tier can see a photo swap: the text is untouched');
    assert.strictEqual(verdict('B5_laundered.png'), 'TAMPERED_CONTENT', 'a print-scan laundered edit is still caught, because the text is read, not the pixel traces');
    assert.strictEqual(verdict('C3_unreadable.jpg'), 'INCONCLUSIVE', 'an unreadable capture is "inconclusive", never a confident answer either way');
    assert.deepStrictEqual(report.results.filter((r) => r.real), [], 'the committed run uses no real captures');
    assert.strictEqual(report.results.filter((r) => r.simulated).length, 6, 'and says which samples are simulated');
});

test('real captures are judged by the same expectations: a file in the override folder replaces the corpus file of the same name', async () => {
    // put a genuinely unreadable picture where a good capture is expected: the same expectation (AUTHENTIC_COPY) must now FAIL
    fs.copyFileSync(path.join(CORPUS_DIR, 'files', 'C3_unreadable.jpg'), path.join(scratch, 'A3_photo_bright.jpg'));
    const report = await runCorpus({ overrideDir: scratch, only: ['A3_photo_bright.jpg', 'A2_scan_300dpi.png'] });
    const a3 = report.results.find((r) => r.file === 'A3_photo_bright.jpg');
    const a2 = report.results.find((r) => r.file === 'A2_scan_300dpi.png');
    assert.deepStrictEqual([a3.real, a3.simulated, a3.ok, a3.actual], [true, false, false, 'INCONCLUSIVE']);
    assert.deepStrictEqual([a2.real, a2.simulated, a2.ok], [false, true, true], 'files that are not overridden are untouched');
    assert.match(formatReport(report), /REAL capture/);
});

test('a corpus whose base document cannot be issued is an error, not a silent pass', async () => {
    const broken = path.join(scratch, 'broken');
    fs.mkdirSync(path.join(broken, 'files'), { recursive: true });
    fs.writeFileSync(path.join(broken, 'manifest.json'), JSON.stringify({ ...manifest, anchoredFields: { ...manifest.anchoredFields, holder: 'Somebody Else' } }));
    for (const f of fs.readdirSync(path.join(CORPUS_DIR, 'files'))) fs.copyFileSync(path.join(CORPUS_DIR, 'files', f), path.join(broken, 'files', f));
    await assert.rejects(() => runCorpus({ corpusDir: broken, only: ['A1_original.png'] }), /could not be issued/);
});
