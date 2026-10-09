// The ONE controlled certificate template, rendered from data, plus ways of damaging the picture the way real life does.
// These are SIMULATIONS of capture conditions (compression, scaling, blur, noise, lighting, tilt). They are not photographs
// taken by real phones, so a pass here is evidence, not proof, that real captures read correctly.
const crypto = require('crypto');
const sharp = require('sharp');
const { photographed, toGray, toPng } = require('./photo');

const W = 1000;
const H = 700;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const DEFAULT_FIELDS = {
    issuer: 'NITC Registrar', docType: 'Degree Certificate', holder: 'Asha Rao', idNumber: 'B210123CS', issuedOn: '15-06-2026',
    payload: { dob: '12-04-2005', programme: 'B.Tech Computer Science', cgpa: '8.7' },
};

/** Where each line sits, so a test can paint over exactly one field. */
const ROW = { issuer: 0, docType: 1, holder: 2, idNumber: 3, dob: 4, programme: 5, cgpa: 6, issuedOn: 7 };
const rowY = (i) => 215 + i * 55;

function svg(fields, { extra = [], photo = true } = {}) {
    const p = fields.payload || {};
    const rows = [
        `Issuer: ${fields.issuer}`, `Document: ${fields.docType}`, `Name: ${fields.holder}`, `Register No: ${fields.idNumber}`,
        `DOB: ${p.dob}`, `Programme: ${p.programme}`, `CGPA: ${p.cgpa}`, `Issued On: ${fields.issuedOn}`, ...extra,
    ];
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
<rect width="${W}" height="${H}" fill="white"/>
<text x="${W / 2}" y="70" text-anchor="middle" font-family="Arial" font-size="38" font-weight="bold">NATIONAL INSTITUTE OF TECHNOLOGY</text>
<text x="${W / 2}" y="125" text-anchor="middle" font-family="Arial" font-size="30">CERTIFICATE OF GRADUATION</text>
<line x1="60" y1="150" x2="${W - 60}" y2="150" stroke="black" stroke-width="2"/>
${rows.map((t, i) => `<text x="60" y="${rowY(i)}" font-family="Arial" font-size="30" fill="black">${esc(t)}</text>`).join('\n')}
${photo ? `<rect x="760" y="190" width="180" height="220" fill="#ddd" stroke="black" stroke-width="2"/><circle cx="850" cy="270" r="40" fill="#999"/><rect x="800" y="320" width="100" height="70" fill="#999"/>` : ''}
</svg>`;
}

/** The certificate as PNG bytes. */
const render = (fields = DEFAULT_FIELDS, options) => sharp(Buffer.from(svg(fields, options))).png().toBuffer();

/** Same certificate with some fields changed (a different person, a different date of birth, ...). */
const withFields = (changes = {}, payload = {}) => ({ ...DEFAULT_FIELDS, ...changes, payload: { ...DEFAULT_FIELDS.payload, ...payload } });

/** "Edited in an image editor": paint a white box over one printed row and write new text in its place. */
async function paintOver(png, row, newText) {
    const y = rowY(ROW[row]);
    const patch = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W - 440}" height="48"><rect width="100%" height="100%" fill="white"/>` +
        `<text x="0" y="36" font-family="Arial" font-size="30">${esc(newText)}</text></svg>`);
    return sharp(png).composite([{ input: patch, left: 60, top: y - 36 }]).png().toBuffer();
}

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

// ---- ways a picture of the certificate gets damaged -------------------------------------------------
const jpeg = (q) => async (png) => sharp(png).jpeg({ quality: q, chromaSubsampling: '4:2:0' }).toBuffer();
const shrink = (f) => async (png) => sharp(png).resize(Math.round(W * f)).png().toBuffer();
const noise = (sigma) => async (png) => sharp(png).composite([{
    input: { create: { width: W, height: H, channels: 3, noise: { type: 'gaussian', mean: 128, sigma } } }, blend: 'overlay',
}]).png().toBuffer();
const rotated = (deg) => async (png) => sharp(png).rotate(deg, { background: '#ffffff' }).png().toBuffer();
const dim = (a, b) => async (png) => sharp(png).linear(a, b).png().toBuffer();
const blur = (sigma) => async (png) => sharp(png).blur(sigma).png().toBuffer();
const pipe = (...steps) => async (png) => { let out = png; for (const s of steps) out = await s(out); return out; };

/** Page seen at an angle on a dark table, then JPEG'd like a phone does. */
const angled = (quad) => async (png) => {
    const page = await toGray(png);
    return sharp(await toPng(photographed(page, quad, 1200, 900, 45))).jpeg({ quality: 82 }).toBuffer();
};

module.exports = {
    DEFAULT_FIELDS, W, H, ROW, render, withFields, paintOver, sha256, svg,
    jpeg, shrink, noise, rotated, dim, blur, pipe, angled,
};
