// Stamping the QR code onto the certificate itself (#58).
//
// WHY THE ORDER MATTERS, and it is the whole design:
//
// The QR carries the document's content hash, and the content hash is read from
// the document by OCR. So the QR cannot be stamped before the hash exists, and
// the hash must not change once it is stamped. Both are satisfied because the
// three tiers look at different things:
//
//   1. read the fields by OCR            -> contentHash   (Tier 2)
//   2. stamp a QR carrying contentHash   -> stamped file
//   3. sha256(stamped file)              -> byteHash      (Tier 1)
//      perceptual hashes of the stamped file              (Tier 3)
//   4. anchor(contentHash, byteHash) and hand out the STAMPED file
//
// Step 2 cannot disturb step 1's answer, because the QR lands in a region the
// template lists as ignored, so OCR never sees it (extract.TEMPLATE.qrRegion,
// which is also in ignoreRegions). stamp.test.js asserts that equality against
// a real re-read rather than trusting it.
//
// The reverse order is the bug this module exists to prevent: hashing the file
// first and stamping afterwards anchors the byte hash of a file nobody will
// ever hold, so Tier 1 could never match on the document actually in someone's
// hand.
//
// WHERE THE QR GOES. Inside the existing ink of the page, never outside it.
// The template's regions are fractions of the page cropped to its printed
// content (imaging.cropToContent), so ink placed beyond the current bounding
// box would move the crop and silently shift every other region, including the
// photo. The reserved box sits in the empty right-hand side below the photo,
// within the bounds the ruled line and the photo frame already set.
//
// A STAMPED QR IS NOT PROOF. It is a pointer, and a real QR photocopies onto a
// forgery perfectly well. Verification still re-reads the document and requires
// the recomputed content hash to equal the one in the QR (verification.js).
const sharp = require('sharp');
const QRCode = require('qrcode');

// Reserved box in the raw rendered page, in pixels of the 1000x700 template.
//
// Chosen by measuring the ink rather than reading the layout: the page's ink
// bounding box is x 60-939, y 43-599, and below the photo (which ends at y=310)
// the rightmost ink is x=578, the end of the "Programme" line. That leaves a
// free rectangle of 339x284 at x 600-939, y 315-599, entirely inside the ink
// bounding box so the content crop does not move.
//
// SIZE IS NOT COSMETIC, AND NEITHER IS THE MODULE PIXEL COUNT. The payload is
// ~170 characters, which at error correction M needs a 53x53-module code; with
// the 4-module quiet zone on each side that is 61 modules across.
//
// A first attempt asked for a 140px code and let the encoder scale to fit. It
// decoded from the issued file but failed once the page was shrunk, and failed
// NON-MONOTONICALLY: 80% decoded, 70% did not, 60% decoded again. That pattern
// is not a module-size limit, it is aliasing. A code whose modules are a
// fractional number of pixels has edges that fall inside pixels, and resampling
// turns them into ambiguous grey.
//
// So the module is pinned to a whole number of pixels (SCALE below) and the box
// is sized to match exactly: 61 modules x 4px = 244px. That is also the largest
// integer-module code that fits the free rectangle measured above.
const SCALE = 4;                                  // pixels per module, exactly
const BOX = { x: 690, y: 350, w: 244, h: 244 };

// Quiet zone, in modules. The QR spec requires 4; below that, readers fail.
const QUIET_MODULES = 4;

class StampError extends Error {
    constructor(message) {
        super(message);
        this.name = 'StampError';
    }
}

/**
 * The QR code on its own, as a PNG with a white quiet zone.
 *
 * errorCorrectionLevel 'M' (~15% recoverable) rather than 'L': the code is
 * printed, then photocopied and photographed, and a crease or a stray mark
 * through a low-redundancy code makes it unreadable.
 *
 * `scale` rather than `width`: scale gives a whole number of pixels per module,
 * width makes the encoder stretch the module grid to hit a pixel total and the
 * resulting fractional modules alias badly when the page is resized.
 *
 * @param {string} payload exact text to encode (see qr.buildQrPayload)
 * @param {number} scale   pixels per module
 * @returns {Promise<{png: Buffer, size: number, modules: number}>}
 */
async function renderQr(payload, scale = SCALE) {
    if (typeof payload !== 'string' || payload.length === 0) throw new StampError('a QR payload is required');
    if (!Number.isInteger(scale) || scale < 2) throw new StampError('the QR needs at least 2 pixels per module to be scannable');
    const png = await QRCode.toBuffer(payload, {
        type: 'png',
        errorCorrectionLevel: 'M',
        margin: QUIET_MODULES,
        scale,
        color: { dark: '#000000ff', light: '#ffffffff' },
    });
    const { width } = await sharp(png).metadata();
    return { png, size: width, modules: width / scale };
}

/**
 * Stamps the QR into the reserved box of a rendered certificate.
 *
 * Images only. A PDF is refused rather than mangled: Tier 2 and Tier 3 are
 * already images-only, so a PDF has no content hash to put in a QR anyway.
 *
 * @param {Buffer} image      PNG or JPEG bytes of the certificate
 * @param {string} payload    exact text to encode
 * @param {{box?: {x,y,w,h}}} [options]
 * @returns {Promise<{buffer: Buffer, box: {x,y,w,h}}>} PNG bytes of the stamped page
 */
async function stampQr(image, payload, { box = BOX } = {}) {
    if (!Buffer.isBuffer(image) || image.length === 0) throw new StampError('an image is required');

    let meta;
    try {
        meta = await sharp(image).metadata();
    } catch {
        throw new StampError('the document could not be read as an image');
    }
    if (meta.format === 'pdf') throw new StampError('a PDF cannot be stamped; the QR is for rendered certificates');
    if (!meta.width || !meta.height) throw new StampError('the document has no usable dimensions');

    // The box is given in template pixels. A page may be rendered at any size,
    // so scale the box. Refusing instead would mean only the exact template
    // resolution could ever be stamped.
    const sx = meta.width / 1000;
    const sy = meta.height / 700;
    const slot = {
        x: Math.round(box.x * sx),
        y: Math.round(box.y * sy),
        w: Math.round(box.w * sx),
        h: Math.round(box.h * sy),
    };
    if (slot.x + slot.w > meta.width || slot.y + slot.h > meta.height) {
        throw new StampError('the reserved QR box does not fit inside this document');
    }

    // How many modules this payload needs, before deciding how big to draw them.
    const probe = await renderQr(payload, 2);
    const modules = probe.modules;

    // Largest WHOLE number of pixels per module that fits the slot. Whole
    // modules are the point: see the aliasing note at the top of the file.
    const scale = Math.floor(Math.min(slot.w, slot.h) / modules);
    if (scale < 2) {
        throw new StampError('the reserved QR box is too small to draw a scannable code for this payload');
    }
    const { png: qr, size } = await renderQr(payload, scale);

    // Centre the code in the slot: the slot is scaled from the template and may
    // not be an exact multiple of the module size.
    const placed = {
        x: slot.x + Math.floor((slot.w - size) / 2),
        y: slot.y + Math.floor((slot.h - size) / 2),
        w: size,
        h: size,
    };

    // PNG out, always: stamping a JPEG and re-encoding as JPEG would add a
    // second generation of compression to the file everyone is handed, and the
    // byte hash is taken from this output.
    const buffer = await sharp(image)
        .composite([{ input: qr, left: placed.x, top: placed.y }])
        .png()
        .toBuffer();

    return { buffer, box: placed, slot, scale, modules };
}

module.exports = { stampQr, renderQr, StampError, BOX, SCALE, QUIET_MODULES };
