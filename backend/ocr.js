// Local OCR with Tesseract.js. Nothing leaves the machine and nothing is downloaded at run time: the English language
// data is committed in ocr-data/, so the demo works with the network off.
const path = require('path');
const { createWorker } = require('tesseract.js');

const LANG_PATH = path.join(__dirname, 'ocr-data');

let workerPromise = null;
let queue = Promise.resolve();

function getWorker() {
    if (!workerPromise) {
        workerPromise = createWorker('eng', 1, { langPath: LANG_PATH, gzip: false, cacheMethod: 'none' })
            // the page has been scaled to a known working size, so tell Tesseract the resolution instead of letting it guess
            .then(async (worker) => { await worker.setParameters({ user_defined_dpi: '200' }); return worker; })
            .catch((err) => { workerPromise = null; throw err; });
    }
    return workerPromise;
}

/**
 * Reads a prepared page image.
 * @returns {Promise<{lines: Array<{text: string, confidence: number, words: Array<{text: string, confidence: number}>}>}>}
 */
function recognize(png) {
    // one job at a time on the shared worker; a failed job must not block the next one
    const job = queue.then(async () => {
        const worker = await getWorker();
        // tesseract.js 6+ returns only plain text unless the layout is asked for; the lines hang off blocks -> paragraphs -> lines
        const { data } = await worker.recognize(png, {}, { blocks: true });
        const lines = (data.blocks || []).flatMap((b) => b.paragraphs || []).flatMap((p) => p.lines || []);
        return {
            lines: lines.map((l) => ({
                text: l.text.replace(/\s+$/, ''),
                confidence: l.confidence,
                words: (l.words || []).map((w) => ({ text: w.text, confidence: w.confidence })),
            })).filter((l) => l.text.trim() !== ''),
        };
    });
    queue = job.catch(() => {});
    return job;
}

/** Stops the worker (tests and graceful shutdown). A later recognize() starts a fresh one. */
async function shutdown() {
    const pending = workerPromise;
    workerPromise = null;
    if (pending) await (await pending).terminate();
}

module.exports = { recognize, shutdown, LANG_PATH };
