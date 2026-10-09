#!/usr/bin/env node
// Builds corpus/files/* and corpus/manifest.json. Deterministic: the same code gives the same pictures (all noise is seeded).
//
//   node corpus/generate.js
//
// EVERY file is synthetic (see README.md): a fictional authority, fictional people, a procedural abstract "photo", ID numbers that
// are not valid in any scheme, and a SPECIMEN marking. The physical steps (print, scan, photograph, WhatsApp) are SIMULATED here
// and flagged `simulated: true`; CAPTURE.md explains how to replace them with real captures.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const backend = (p) => path.join(__dirname, '..', 'backend', p);
const c = require(backend('test/fixtures/certificate'));
const sharp = require(backend('node_modules/sharp'));
const { contentHash } = require(backend('content-hash'));

const OUT = path.join(__dirname, 'files');
const HEADER = ['REPUBLIC OF TESTLAND', 'CIVIL REGISTRY CERTIFICATE'];
const MARKS = c.specimenMarks();

// The anchored document. Names are fictional; the ID is deliberately not in any real scheme (and has no runs of zeros, which OCR
// reads poorly: that is a property of the engine, not of the corpus).
const BASE = {
    issuer: 'Testland Civil Registry', docType: 'Degree Certificate', holder: 'Ananya Testsubject', idNumber: 'T482915TS', issuedOn: '15-06-2026',
    payload: { dob: '12-04-2005', programme: 'B.Tech Computer Science', cgpa: '8.7' },
};
const PHOTO_SEED = 11;          // an abstract procedural picture, not a face
const OTHER_PHOTO_SEED = 44;

const render = (fields = BASE, seed = PHOTO_SEED) => c.renderWithPhoto(seed, fields, { header: HEADER, marks: MARKS });
const withFields = (changes, payload = {}) => ({ ...BASE, ...changes, payload: { ...BASE.payload, ...payload } });

// ---- a copy-move forgery: the new digit's pixels come from the SAME document ---------------------------------------------------
const rowTop = (row) => 215 + c.ROW[row] * 55 - 26;      // top of the band holding one printed row
const BAND = 36;

/** Horizontal runs of ink in one printed row: [{x0, x1}] left to right. Each printed glyph is a run. */
async function inkRuns(png, row) {
    const { data, info } = await sharp(png).extract({ left: 0, top: rowTop(row), width: c.W, height: BAND }).greyscale().raw().toBuffer({ resolveWithObject: true });
    const runs = [];
    let start = -1;
    for (let x = 0; x <= info.width; x++) {
        let ink = false;
        if (x < info.width) for (let y = 0; y < info.height; y++) if (data[y * info.width + x] < 128) { ink = true; break; }
        if (ink && start < 0) start = x;
        if (!ink && start >= 0) { runs.push({ x0: start, x1: x - 1 }); start = -1; }
    }
    return runs;
}

/** Replaces the last glyph of row `toRow` with a copy of glyph number `fromIndex` of row `fromRow`. */
async function copyMoveLastGlyph(png, { fromRow, fromIndex, toRow }) {
    const from = (await inkRuns(png, fromRow))[fromIndex];
    const toRuns = await inkRuns(png, toRow);
    const to = toRuns[toRuns.length - 1];
    if (!from || !to) throw new Error('copy-move: glyph not found');
    const width = from.x1 - from.x0 + 3;
    if (from.x1 - from.x0 < 8 || from.x1 - from.x0 > 22 || to.x1 - to.x0 < 8 || to.x1 - to.x0 > 22) throw new Error(`copy-move: glyph sizes look wrong ${JSON.stringify({ from, to })}`);
    const source = await sharp(png).extract({ left: from.x0 - 1, top: rowTop(fromRow), width, height: BAND }).toBuffer();
    const blank = await sharp({ create: { width, height: BAND, channels: 3, background: '#ffffff' } }).png().toBuffer();
    return sharp(png).composite([{ input: blank, left: to.x0 - 1, top: rowTop(toRow) }, { input: source, left: to.x0 - 1, top: rowTop(toRow) }]).png().toBuffer();
}

// ---- the samples ----------------------------------------------------------------------------------------------------------------
const diff = (field, anchored, presented) => ({ field, anchored, presented });

async function build() {
    const a1 = await render();
    const b1 = await copyMoveLastGlyph(a1, { fromRow: 'cgpa', fromIndex: 4, toRow: 'dob' });     // "8" of "CGPA: 8.7" onto the last digit of the year
    const printScan = c.pipe(c.rotated(0.6), c.blur(0.7), c.noise(10, 5), c.jpeg(72));            // a stand-in for print + rescan
    const wa = await c.pipe(c.angled([[170, 120], [1020, 150], [930, 790], [130, 730]]), c.noise(6, 2), c.jpeg(88))(a1);

    const samples = [
        // ---- Group A: genuine, must verify
        { file: 'A1_original.png', group: 'genuine', derivation: 'The digital master. This is the anchored document.', simulated: false, bytes: a1,
            expectedVerdict: 'AUTHENTIC_ORIGINAL' },
        { file: 'A2_scan_300dpi.png', group: 'genuine', derivation: 'A1 enlarged to scanner resolution with a little blur, sensor noise and a 0.4 degree skew. SIMULATED scan.', simulated: true,
            bytes: await c.pipe(c.shrink(1.75), c.rotated(0.4), c.blur(0.5), c.noise(4, 1))(a1), expectedVerdict: 'AUTHENTIC_COPY' },
        { file: 'A3_photo_bright.jpg', group: 'genuine', derivation: 'A1 seen at a mild angle on a dark table, sensor noise, JPEG 88. SIMULATED photograph.', simulated: true,
            bytes: wa, expectedVerdict: 'AUTHENTIC_COPY' },
        { file: 'A4_photo_lowlight.jpg', group: 'genuine', derivation: 'A1 at a steeper angle, dim, blurred, noisy, JPEG 50. SIMULATED photograph on a different (worse) camera.', simulated: true,
            bytes: await c.pipe(c.angled([[190, 150], [990, 90], [1000, 780], [140, 750]]), c.dim(0.6, -15), c.noise(15, 3), c.blur(0.8), c.jpeg(50))(a1), expectedVerdict: 'AUTHENTIC_COPY' },
        { file: 'A5_whatsapp.jpg', group: 'genuine', derivation: 'A3 shrunk and recompressed twice, the way a messaging app does. SIMULATED round trip: not a real WhatsApp transfer.', simulated: true,
            bytes: await c.pipe(c.jpeg(70), c.shrink(0.8), c.jpeg(65))(wa), expectedVerdict: 'AUTHENTIC_COPY' },

        // ---- Group B: tampered, must be caught
        { file: 'B1_dob_digit.png', group: 'tampered', severity: 'L1', manipulation: 'copy-move', simulated: false,
            derivation: 'The last digit of the date of birth replaced by a copy of the "8" printed in the CGPA line of the same document.', bytes: b1,
            tamperedFields: [diff('payload.dob', '2005-04-12', '2008-04-12')], expectedVerdict: 'TAMPERED_CONTENT' },
        { file: 'B2_name_field.png', group: 'tampered', severity: 'L2', manipulation: 'field replacement', simulated: false,
            derivation: 'The name line painted over and re-typed in the same font.', bytes: await c.paintOver(a1, 'holder', 'Name: Bhavya Fakename'),
            tamperedFields: [diff('holder', 'ANANYA TESTSUBJECT', 'BHAVYA FAKENAME')], expectedVerdict: 'TAMPERED_CONTENT' },
        { file: 'B3_photo_swap.png', group: 'tampered', severity: 'L2', manipulation: 'splicing', simulated: false,
            derivation: 'The photo replaced by a different synthetic picture. Every printed word is untouched.', bytes: await render(BASE, OTHER_PHOTO_SEED),
            tamperedRegions: [{ region: 'photo', grid: [1, 3] }], expectedVerdict: 'TAMPERED_VISUAL' },
        { file: 'B4_multi_field.png', group: 'tampered', severity: 'L3', manipulation: 'field replacement', simulated: false,
            derivation: 'Name, date of birth and CGPA all altered. (The ID number is left alone; see B6 for why.)',
            bytes: await c.paintOver(await c.paintOver(await c.paintOver(a1, 'holder', 'Name: Rohan Fakename'), 'dob', 'DOB: 12-04-2001'), 'cgpa', 'CGPA: 9.9'),
            tamperedFields: [diff('holder', 'ANANYA TESTSUBJECT', 'ROHAN FAKENAME'), diff('payload.dob', '2005-04-12', '2001-04-12'), diff('payload.cgpa', '8.7', '9.9')],
            expectedVerdict: 'TAMPERED_CONTENT' },
        { file: 'B5_laundered.png', group: 'tampered', severity: 'L1', manipulation: 'copy-move + print-scan laundering', simulated: true,
            derivation: 'B1 passed through a stand-in for print and rescan (skew, blur, noise, JPEG 72) to wipe digital traces. SIMULATED: not a real print-scan.',
            bytes: await printScan(b1), tamperedFields: [diff('payload.dob', '2005-04-12', '2008-04-12')], expectedVerdict: 'TAMPERED_CONTENT' },
        { file: 'B6_id_number.png', group: 'tampered', severity: 'L2', manipulation: 'field replacement', simulated: false,
            derivation: 'Only the ID number changed. The ID is how a document is matched to its record, so this reads as a document nobody registered.',
            bytes: await c.paintOver(a1, 'idNumber', 'Register No: T118204TS'), expectedVerdict: 'NOT_REGISTERED',
            note: 'Deliberate design consequence, not a miss: a changed ID cannot be linked to the original, so the answer is "not registered", which is safe. Differs from the issue table, which expected TAMPERED_CONTENT with the ID named.' },

        // ---- Group C: negative controls, must NOT verify
        { file: 'C1_different_person.png', group: 'negative', manipulation: 'same template and the SAME photo, different person', simulated: false,
            derivation: 'A genuinely different synthetic person on the same template with the same picture: as close in appearance as two cards can be. Must not be rescued by visual similarity.',
            bytes: await render(withFields({ holder: 'Bhavya Testsubject', idNumber: 'T730264TS' }, { dob: '03-09-2004' })), expectedVerdict: 'NOT_REGISTERED' },
        { file: 'C2_never_anchored.png', group: 'negative', manipulation: 'never issued', simulated: false,
            derivation: 'A valid-looking certificate (fictional person, different photo) that was never issued through the system.',
            bytes: await render(withFields({ holder: 'Chinmay Specimen', idNumber: 'T906137TS' }, { dob: '21-11-2003', cgpa: '7.9' }), 66), expectedVerdict: 'NOT_REGISTERED' },
        { file: 'C3_unreadable.jpg', group: 'negative', manipulation: 'unreadable capture', simulated: true,
            derivation: 'A1 heavily blurred and darkened. SIMULATED capture. Must be "inconclusive", not a confident verdict either way.',
            bytes: await c.pipe(c.blur(6), c.dim(0.5, -30), c.jpeg(45))(a1), expectedVerdict: 'INCONCLUSIVE' },
    ];

    fs.mkdirSync(OUT, { recursive: true });
    for (const f of fs.readdirSync(OUT)) fs.rmSync(path.join(OUT, f));
    for (const s of samples) {
        fs.writeFileSync(path.join(OUT, s.file), s.bytes);
        s.sha256 = crypto.createHash('sha256').update(s.bytes).digest('hex');
        s.synthetic = true;
        delete s.bytes;
    }
    const manifest = {
        about: 'Ground truth for the forgery corpus. Every file is synthetic and carries a SPECIMEN marking. See README.md.',
        specimenText: c.SPECIMEN_TEXT,
        generatedBy: 'node corpus/generate.js',
        baseDocument: 'A1_original.png',
        anchoredFields: BASE,
        anchoredContentHash: contentHash(BASE).hash,
        samples,
    };
    fs.writeFileSync(path.join(__dirname, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
}

if (require.main === module) {
    build().then((m) => { console.log(`wrote ${m.samples.length} files to ${path.relative(process.cwd(), OUT) || '.'} and manifest.json`); })
        .catch((err) => { console.error(err); process.exit(1); });
}
module.exports = { build, BASE, HEADER };
