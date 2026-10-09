// Tier 2 robustness harness: the same certificate, damaged in many ways. For every copy:
//   - the byte hash (Tier 1) must DIFFER from the original (otherwise the copy is not really a different file), and
//   - judged against what the issuer anchored, Tier 2 must say MATCH, or INCONCLUSIVE if the picture is too poor.
//     It must never say MISMATCH: that is a false alarm, accusing a genuine document of having been altered.
//   npm run robustness
// These are simulated capture conditions, not photographs from real phones: see test/fixtures/certificate.js.
const sharp = require('sharp');
const c = require('../test/fixtures/certificate');
const { analyseImage, compareToAnchor } = require('../tier2');
const { contentHash } = require('../content-hash');
const { shutdown } = require('../ocr');

// "supported": ordinary damage a real copy suffers. Must be recognised as the anchored document.
// "extreme": damage past what a reader can be expected to survive. May be inconclusive, must never raise a false alarm.
const VARIANTS = [
    { name: 'original PNG (control)', kind: 'supported', make: async (png) => png },
    { name: 'JPEG q85', kind: 'supported', make: c.jpeg(85) },
    { name: 'JPEG q60', kind: 'supported', make: c.jpeg(60) },
    { name: 'JPEG q30', kind: 'supported', make: c.jpeg(30) },
    { name: 'resize to 75%', kind: 'supported', make: c.shrink(0.75) },
    { name: 'resize to 50%', kind: 'supported', make: c.shrink(0.5) },
    { name: 'greyscale', kind: 'supported', make: async (png) => sharp(png).toColourspace('b-w').png({ palette: false }).toBuffer() },
    { name: 'WhatsApp-style (60% size, JPEG q65, 4:2:0)', kind: 'supported', make: c.pipe(c.shrink(0.6), c.jpeg(65)) },
    { name: 'rotated +2 degrees', kind: 'supported', make: c.rotated(2) },
    { name: 'rotated -4 degrees', kind: 'supported', make: c.rotated(-4) },
    { name: 'dim lighting (x0.6)', kind: 'supported', make: c.dim(0.6, 0) },
    { name: 'washed out (x0.55 + 90)', kind: 'supported', make: c.dim(0.55, 90) },
    { name: 'slight blur (sigma 1)', kind: 'supported', make: c.blur(1) },
    { name: 'sensor noise (mild, sigma 10)', kind: 'supported', make: c.noise(10) },
    { name: 'photographed at an angle (mild), JPEG q82', kind: 'supported', make: c.angled([[160, 110], [1000, 170], [950, 800], [110, 740]]) },
    { name: 'photographed at an angle (strong), JPEG q82', kind: 'supported', make: c.angled([[220, 90], [1080, 240], [980, 810], [120, 700]]) },
    { name: 'angled + blur + noise + JPEG q50 (phone-in-a-room)', kind: 'supported',
      make: c.pipe(c.angled([[170, 120], [1020, 150], [930, 790], [130, 730]]), c.blur(0.8), c.noise(15), c.jpeg(50)) },
    { name: 'EXTREME: JPEG q10', kind: 'extreme', make: c.jpeg(10) },
    { name: 'EXTREME: resize to 30%', kind: 'extreme', make: c.shrink(0.3) },
    { name: 'EXTREME: heavy blur (sigma 4)', kind: 'extreme', make: c.blur(4) },
    { name: 'EXTREME: rotated 25 degrees', kind: 'extreme', make: c.rotated(25) },
    { name: 'EXTREME: heavy sensor noise (sigma 20)', kind: 'extreme', make: c.noise(20) },
];

/** @returns {Promise<Array<{name, kind, control, bytesDiffer, outcome: 'MATCH'|'INCONCLUSIVE'|'FALSE_ALARM', notes?}>>} */
async function runRobustness({ variants = VARIANTS, fields = c.DEFAULT_FIELDS } = {}) {
    const original = await c.render(fields);
    const anchored = contentHash(fields);                    // what the issuer anchored at issuance
    const rows = [];
    for (const v of variants) {
        const copy = await v.make(original);
        const analysis = await analyseImage(copy);
        const result = compareToAnchor(anchored.record, anchored.hash, analysis);
        const doubtful = [...(analysis.weak || []).map((w) => `${w.field}@${Math.round(w.confidence)}`),
            ...(analysis.problems || []).map((p) => `${p.field}:${p.problem}`)];
        rows.push({
            name: v.name, kind: v.kind, control: v.name.includes('control'), bytesDiffer: c.sha256(copy) !== c.sha256(original),
            outcome: result.status === 'MISMATCH' ? 'FALSE_ALARM' : result.status,
            notes: [analysis.steps.flattened ? 'flattened' : '', analysis.steps.skewDegrees ? `deskewed ${analysis.steps.skewDegrees}°` : '',
                doubtful.length ? `doubtful: ${doubtful.slice(0, 4).join(', ')}${doubtful.length > 4 ? ', ...' : ''}` : ''].filter(Boolean).join('; '),
        });
    }
    return rows;
}

/** True when every copy really differs in bytes, every supported copy matches, and nothing anywhere raises a false alarm. */
function verdict(rows) {
    return rows.every((r) => (r.control || r.bytesDiffer) && r.outcome !== 'FALSE_ALARM' && (r.kind !== 'supported' || r.outcome === 'MATCH'));
}

function toMarkdown(rows) {
    const out = ['| copy | bytes differ (Tier 1) | Tier 2 against the anchor | notes |', '|---|---|---|---|'];
    for (const r of rows) {
        out.push(`| ${r.name} | ${r.control ? '(original)' : (r.bytesDiffer ? 'yes' : 'NO: same bytes!')} | ${r.outcome} | ${r.notes} |`);
    }
    const n = (o) => rows.filter((r) => r.outcome === o).length;
    out.push('', `${n('MATCH')} of ${rows.length} copies matched the anchored document; ${n('INCONCLUSIVE')} were reported inconclusive ` +
        `(picture too poor to be sure); ${n('FALSE_ALARM')} were wrongly called altered.`);
    return out.join('\n');
}

if (require.main === module) {
    runRobustness().then(async (rows) => {
        console.log(toMarkdown(rows));
        await shutdown();
        process.exit(verdict(rows) ? 0 : 1);
    }, async (err) => { console.error(err); await shutdown(); process.exit(1); });
}

module.exports = { runRobustness, verdict, toMarkdown, VARIANTS };
