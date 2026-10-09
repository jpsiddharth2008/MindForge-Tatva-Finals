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

// The photo sits entirely inside ONE cell of Tier 3's 4x4 grid (column 3, row 1: x 0.75-1.0, y 0.25-0.5 of the page),
// so replacing it can be localised to a single cell.
const PHOTO = { x: 780, y: 185, w: 160, h: 125 };
/** A portrait placeholder. `style` lets a test swap in a different "person". */
function photoBox(style = 'a') {
    const { x, y, w, h } = PHOTO;
    const head = style === 'a' ? `<circle cx="${x + 80}" cy="${y + 40}" r="26" fill="#888"/>` : `<ellipse cx="${x + 80}" cy="${y + 48}" rx="22" ry="34" fill="#222"/>`;
    const body = style === 'a' ? `<rect x="${x + 40}" y="${y + 80}" width="80" height="36" fill="#888"/>` : `<rect x="${x + 25}" y="${y + 88}" width="110" height="30" fill="#444"/>`;
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${style === 'a' ? '#ddd' : '#bbb'}" stroke="black" stroke-width="2"/>${head}${body}`;
}

const DEFAULT_HEADER = ['NATIONAL INSTITUTE OF TECHNOLOGY', 'CERTIFICATE OF GRADUATION'];

/** The marking every file in the forgery corpus carries (corpus/README.md). */
const SPECIMEN_TEXT = 'SPECIMEN — NOT A VALID DOCUMENT — GENERATED FOR TESTING';

/**
 * The specimen marking: small pale print along the foot. Pale on purpose: it must stay below the "ink" level that sets the page crop and
 * that OCR reads, or it would move the template's regions and be read as a field. (A large diagonal SPECIMEN across the page was
 * tried: it made the OCR lose the Programme line.)
 */
function specimenMarks() {
    return `<text x="${W / 2}" y="${H - 22}" text-anchor="middle" font-family="Arial" font-size="16" fill="#b0b0b0">${SPECIMEN_TEXT}</text>`;
}

function svg(fields, { extra = [], photo = true, photoStyle = 'a', header = DEFAULT_HEADER, marks = '' } = {}) {
    const p = fields.payload || {};
    const rows = [
        `Issuer: ${fields.issuer}`, `Document: ${fields.docType}`, `Name: ${fields.holder}`, `Register No: ${fields.idNumber}`,
        `DOB: ${p.dob}`, `Programme: ${p.programme}`, `CGPA: ${p.cgpa}`, `Issued On: ${fields.issuedOn}`, ...extra,
    ];
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
<rect width="${W}" height="${H}" fill="white"/>
<text x="${W / 2}" y="70" text-anchor="middle" font-family="Arial" font-size="38" font-weight="bold">${esc(header[0])}</text>
<text x="${W / 2}" y="125" text-anchor="middle" font-family="Arial" font-size="30">${esc(header[1])}</text>
<line x1="60" y1="150" x2="${W - 60}" y2="150" stroke="black" stroke-width="2"/>
${rows.map((t, i) => `<text x="60" y="${rowY(i)}" font-family="Arial" font-size="30" fill="black">${esc(t)}</text>`).join('\n')}
${photo ? photoBox(photoStyle) : ''}
${marks}
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

/**
 * A procedural "photograph": smooth, seeded random structure, so photo 11 and photo 22 differ the way two people's photos do.
 * (The flat placeholder portraits are too alike to stand in for different people.)
 */
async function proceduralPhoto(seed, w = PHOTO.w, h = PHOTO.h) {
    let s = seed;
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    const raw = Buffer.alloc(w * h * 3);
    for (let i = 0; i < raw.length; i++) raw[i] = Math.floor(rnd() * 256);
    return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).blur(14).normalise().png().toBuffer();
}

/** The certificate with a procedural photo in the photo box. Different seeds are different people's photos. */
async function renderWithPhoto(seed, fields = DEFAULT_FIELDS, options = {}) {
    const base = await sharp(Buffer.from(svg(fields, { ...options, photo: false }))).png().toBuffer();
    return sharp(base).composite([{ input: await proceduralPhoto(seed), left: PHOTO.x, top: PHOTO.y }]).png().toBuffer();
}

// ---- ways a picture of the certificate gets damaged -------------------------------------------------
const jpeg = (q) => async (png) => sharp(png).jpeg({ quality: q, chromaSubsampling: '4:2:0' }).toBuffer();
const shrink = (f) => async (png) => sharp(png).resize(Math.round(W * f)).png().toBuffer();
/**
 * Gaussian sensor noise, overlaid on the picture. SEEDED: the same (sigma, seed) always gives the same pixels, so a test that uses
 * it cannot pass on one run and fail on the next. (sharp's own noise generator is random on every call.) Sized to the actual image.
 */
const noise = (sigma, seed = 1) => async (png) => {
    const { width, height } = await sharp(png).metadata();
    let state = seed >>> 0 || 1;
    const rnd = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return (state + 1) / 4294967297; };   // uniform in (0, 1)
    const raw = Buffer.alloc(width * height * 3);
    for (let i = 0; i < raw.length; i += 2) {                                    // Box-Muller makes two normals per pair of uniforms
        const r = Math.sqrt(-2 * Math.log(rnd())); const t = 2 * Math.PI * rnd();
        raw[i] = Math.max(0, Math.min(255, Math.round(128 + sigma * r * Math.cos(t))));
        if (i + 1 < raw.length) raw[i + 1] = Math.max(0, Math.min(255, Math.round(128 + sigma * r * Math.sin(t))));
    }
    return sharp(png).composite([{ input: raw, raw: { width, height, channels: 3 }, blend: 'overlay' }]).png().toBuffer();
};
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
    DEFAULT_FIELDS, DEFAULT_HEADER, SPECIMEN_TEXT, specimenMarks, W, H, ROW, PHOTO, render, renderWithPhoto, proceduralPhoto, withFields, paintOver, sha256, svg,
    jpeg, shrink, noise, rotated, dim, blur, pipe, angled,
};
