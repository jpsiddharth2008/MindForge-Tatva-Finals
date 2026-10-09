// Helpers that fake "a photo of a page": put a flat page image onto a dark background at a chosen angle.
const sharp = require('sharp');
const im = require('../../imaging');

/** Puts `page` (greyscale {data,width,height}) on a dark canvas at the corners `quad` (TL, TR, BR, BL). */
function photographed(page, quad, W = 900, H = 700, bg = 40) {
    const rect = [[0, 0], [page.width - 1, 0], [page.width - 1, page.height - 1], [0, page.height - 1]];
    const toPage = im.solveHomography(quad, rect);                  // canvas -> page
    const out = new Uint8Array(W * H).fill(bg);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const [sx, sy] = im.applyH(toPage, x, y);
            if (sx < 0 || sy < 0 || sx > page.width - 1 || sy > page.height - 1) continue;
            out[y * W + x] = page.data[Math.round(sy) * page.width + Math.round(sx)];
        }
    }
    return { data: out, width: W, height: H };
}

/** PNG/JPEG bytes -> greyscale {data,width,height}, no downscaling. */
async function toGray(buffer) {
    const { data, info } = await sharp(buffer).flatten({ background: '#fff' }).greyscale().raw().toBuffer({ resolveWithObject: true });
    return { data: new Uint8Array(data), width: info.width, height: info.height };
}

const toPng = (g) => sharp(Buffer.from(g.data), { raw: { width: g.width, height: g.height, channels: 1 } }).png().toBuffer();

module.exports = { photographed, toGray, toPng };
