// Measures Tier 3 distances on simulated captures so the thresholds in config/tier3.json come from data, not guesses.
//   npm run calibrate-tier3
// IMPORTANT: these are SIMULATED captures of one synthetic certificate with procedural photos. Real phones, real cards and real
// photo-swap forgeries will differ. Re-run this on a real sample before relying on the thresholds.
const sharp = require('sharp');
const c = require('../test/fixtures/certificate');
const { analyseVisual, compareVisual, advice } = require('../phash');
const { TEMPLATE } = require('../extract');

const ORIGINAL_SEED = 11;
const SWAP_SEEDS = [22, 33, 44, 55, 66, 77];                       // six other people's photos
const OPTIONS = { regions: { photo: TEMPLATE.photoRegion } };
const OPEN = { cellFar: 999, regionFar: 999, wholeFar: 999, maxLocalisedCells: 999 };   // measure only: never classify here

const RECAPTURES = [
    ['JPEG q85', c.jpeg(85)], ['JPEG q60', c.jpeg(60)], ['JPEG q30', c.jpeg(30)], ['resize 75%', c.shrink(0.75)], ['resize 50%', c.shrink(0.5)],
    ['greyscale', async (p) => sharp(p).toColourspace('b-w').png({ palette: false }).toBuffer()],
    ['WhatsApp-style', c.pipe(c.shrink(0.6), c.jpeg(65))], ['rotated +2', c.rotated(2)], ['rotated -4', c.rotated(-4)],
    ['dim x0.6', c.dim(0.6, 0)], ['washed x0.55+90', c.dim(0.55, 90)], ['blur 1', c.blur(1)],
    ...[1, 2, 3, 4, 5, 6].map((seed) => [`noise 10 (seed ${seed})`, c.noise(10, seed)]),     // seeded: the same pixels every run, and several samples to see the spread
    ['noise 15 (seed 1)', c.noise(15, 1)],
    ['angled mild', c.angled([[160, 110], [1000, 170], [950, 800], [110, 740]])],
    ['angled strong', c.angled([[220, 90], [1080, 240], [980, 810], [120, 700]])],
    ['angled + blur + noise + q50', c.pipe(c.angled([[170, 120], [1020, 150], [930, 790], [130, 730]]), c.blur(0.8), c.noise(15), c.jpeg(50))],
];

const PHOTO_TILE = [1, 3];
const flat = (cells) => cells.flat();

async function measure() {
    const original = await analyseVisual(await c.renderWithPhoto(ORIGINAL_SEED), OPTIONS);
    const against = async (png) => compareVisual(original, await analyseVisual(png, OPTIONS), OPEN);
    const recaptures = [];
    for (const [name, make] of RECAPTURES) recaptures.push({ name, ...(await against(await make(await c.renderWithPhoto(ORIGINAL_SEED)))) });
    const swaps = [];
    for (const seed of SWAP_SEEDS) swaps.push({ name: `photo ${seed}`, ...(await against(await c.renderWithPhoto(seed))) });
    const person = await against(await c.renderWithPhoto(ORIGINAL_SEED, c.withFields({ holder: 'Ravi Menon', idNumber: 'B210999EE' }, { dob: '03-09-2004', cgpa: '7.9' })));
    const dob = await against(await c.renderWithPhoto(ORIGINAL_SEED, c.withFields({}, { dob: '12-04-2003' })));
    return { original, recaptures, swaps, person, dob };
}

/** What a set of thresholds would have said about every measured case. */
function classify(m, t) {
    const verdict = (r) => {
        const diverged = flat(r.cells).filter((d) => d > t.cellFar).length;
        const changed = Object.values(r.regionDistances).filter((d) => d > t.regionFar).length;
        if (diverged > t.maxLocalisedCells) return 'UNCLEAR';
        return diverged > 0 || changed > 0 ? 'REVIEW' : 'CONSISTENT';
    };
    const count = (rows) => rows.reduce((o, r) => { const v = verdict(r); o[v] = (o[v] || 0) + 1; return o; }, {});
    return { recaptures: count(m.recaptures), swaps: count(m.swaps), person: verdict(m.person), dob: verdict(m.dob) };
}

/** Searches for thresholds that never send a genuine re-capture to REVIEW, and catch as many swaps as possible. */
function recommend(m) {
    let best = null;
    for (const cellFar of [8, 10, 12, 14, 16, 20, 24, 28]) for (const regionFar of [8, 10, 12, 14, 16, 18, 20]) for (const maxLocalisedCells of [1, 2, 3]) {
        const t = { cellFar, regionFar, maxLocalisedCells, wholeFar: 0 };
        const r = classify(m, t);
        const falseReview = r.recaptures.REVIEW || 0;
        const caught = r.swaps.REVIEW || 0;
        const score = [-falseReview, caught, regionFar, cellFar];          // fewest false alarms, then most swaps caught, then the larger margins
        if (!best || score.some((v, i) => (v !== best.score[i] ? v > best.score[i] : false) && score.slice(0, i).every((x, j) => x === best.score[j]))) best = { t, r, score };
    }
    return best;
}

function report(m, thresholds) {
    const out = ['## Tier 3 calibration (simulated captures)', '',
        `${m.recaptures.length} re-captures of one certificate, ${m.swaps.length} different photos in its photo box. Distances are Hamming (0-64).`, '',
        '| re-capture | whole page | largest tile | tiles over 12 | photo region |', '|---|---|---|---|---|'];
    for (const r of m.recaptures) out.push(`| ${r.name} | ${r.distance} | ${Math.max(...flat(r.cells))} | ${flat(r.cells).filter((d) => d > 12).length} | ${r.regionDistances.photo} |`);
    out.push('', '| other photo in the box | whole page | photo tile | other tiles (max) | photo region |', '|---|---|---|---|---|');
    for (const r of m.swaps) {
        const others = flat(r.cells.map((row, i) => row.filter((_, j) => !(i === PHOTO_TILE[0] && j === PHOTO_TILE[1]))));
        out.push(`| ${r.name} | ${r.distance} | ${r.cells[PHOTO_TILE[0]][PHOTO_TILE[1]]} | ${Math.max(...others)} | ${r.regionDistances.photo} |`);
    }
    out.push('', `different person, same template: largest tile ${Math.max(...flat(m.person.cells))}, photo region ${m.person.regionDistances.photo}`);
    out.push(`only the date of birth changed:   largest tile ${Math.max(...flat(m.dob.cells))}, photo region ${m.dob.regionDistances.photo}   (text edits are invisible to a perceptual hash)`);
    const rec = recommend(m);
    out.push('', '**best thresholds found**: ' + JSON.stringify(rec.t));
    out.push(`  re-captures: ${JSON.stringify(rec.r.recaptures)}   photo swaps: ${JSON.stringify(rec.r.swaps)}   different person: ${rec.r.person}   DOB-only edit: ${rec.r.dob}`);
    if (thresholds) {
        const now = classify(m, thresholds);
        const { cellFar, regionFar, wholeFar, maxLocalisedCells } = thresholds;
        out.push('', `**config/tier3.json thresholds** ${JSON.stringify({ cellFar, regionFar, wholeFar, maxLocalisedCells })}`, `  re-captures: ${JSON.stringify(now.recaptures)}   photo swaps: ${JSON.stringify(now.swaps)}   different person: ${now.person}   DOB-only edit: ${now.dob}`);
    }
    return out.join('\n');
}

if (require.main === module) {
    let thresholds = null;
    try { thresholds = require('../phash').loadThresholds(); } catch { /* config not written yet */ }
    measure().then((m) => console.log(report(m, thresholds)), (e) => { console.error(e); process.exit(1); });
}

module.exports = { measure, classify, recommend, report, RECAPTURES, advice };
