// Issue #65: the look-hash is stored with the record at issuance (in MongoDB, never on chain) and is advisory.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { startMongo } = require('./mongo');
const { analyseVisual, compareVisual, advice, loadThresholds } = require('../phash');
const { TEMPLATE } = require('../extract');
const c = require('./fixtures/certificate');
const { fakeS3, memoryLogger, start, loginToken } = require('./helpers');

let mongo;
let documents;
before(async () => { mongo = await startMongo(); documents = mongo.documents; });
after(async () => { await mongo.stop(); });
beforeEach(async () => { await documents.model.deleteMany({}); });

const T = loadThresholds();
const look = (png) => analyseVisual(png, { regions: { photo: TEMPLATE.photoRegion } });

async function api(opts = {}) {
    const server = await start(opts.s3 || fakeS3(), { documents, ...opts });
    const { token } = await loginToken(server.url);
    const send = (bytes, { type = 'image/png', name = 'cert.png' } = {}) => {
        const form = new FormData();
        form.append('file', new Blob([bytes], { type }), name);
        return fetch(`${server.url}/api/anchor`, { method: 'POST', body: form, headers: { Authorization: `Bearer ${token}` } });
    };
    return { ...server, send };
}

test('issuing an image stores its look-hash in MongoDB: page, 16 tiles and the photo region; it is never sent back to clients', async () => {
    const server = await api();
    try {
        const res = await server.send(await c.renderWithPhoto(11));
        const body = await res.json();
        assert.strictEqual(res.status, 200);
        assert.ok(!('visual' in body.document), 'the record view does not carry it');
        const row = await documents.findBySha256(body.hash);
        assert.match(row.visual.phash.h, /^[0-9a-f]{16}$/);
        assert.strictEqual(row.visual.grid.length, 4);
        assert.strictEqual(row.visual.grid.flat().length, 16);
        assert.deepStrictEqual(Object.keys(row.visual.regions), ['photo']);
        assert.ok(JSON.stringify(row.visual).length < 3000, 'a small, fixed-size record');
        assert.ok(!JSON.stringify(row.visual).includes(row.sha256), 'it holds fuzzy look-hashes only');
    } finally { await server.close(); }
});

test('what comes back from the database compares correctly: a re-capture is CONSISTENT, a swapped photo is REVIEW', async () => {
    const server = await api();
    try {
        const body = await (await server.send(await c.renderWithPhoto(11))).json();
        const stored = (await documents.findBySha256(body.hash)).visual;
        const recapture = await look(await c.pipe(c.shrink(0.6), c.jpeg(60))(await c.renderWithPhoto(11)));
        const swapped = await look(await c.renderWithPhoto(44));
        assert.strictEqual(advice(compareVisual(stored, recapture, T)), 'CONSISTENT');
        const r = compareVisual(stored, swapped, T);
        assert.strictEqual(advice(r), 'REVIEW');
        assert.deepStrictEqual(r.changedRegions, ['photo']);
    } finally { await server.close(); }
});

test('a PDF has no look-hash', async () => {
    const server = await api({ visualise: async () => { throw new Error('must not run for a PDF'); } });
    try {
        const body = await (await server.send(Buffer.from('%PDF-1.4\nplain\n'), { type: 'application/pdf', name: 'a.pdf' })).json();
        assert.strictEqual((await documents.findBySha256(body.hash)).visual, undefined);
    } finally { await server.close(); }
});

test('if the look-hash cannot be computed, issuance still succeeds, a warning is logged, and nothing sensitive is in it', async () => {
    const { logger, lines } = memoryLogger();
    const server = await api({ logger, visualise: async () => { throw new Error('boom at mongodb://u:Sup3rS3cretPw@host/db'); } });
    try {
        const res = await server.send(await c.renderWithPhoto(11));
        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual((await documents.findBySha256(body.hash)).visual, undefined);
        const logged = lines.join('\n');
        assert.ok(logged.includes('could not compute the visual hash'));
        assert.ok(!logged.includes('Sup3rS3cretPw'), 'the logger scrubs it');
    } finally { await server.close(); }
});

test('a duplicate upload does not pay for the look-hash again, and does not overwrite the stored one', async () => {
    let runs = 0;
    const visualise = async (img) => { runs += 1; return look(img); };
    const server = await api({ visualise });
    try {
        const png = await c.renderWithPhoto(11);
        const first = await (await server.send(png)).json();
        assert.strictEqual(runs, 1);
        const stored = (await documents.findBySha256(first.hash)).visual;
        const again = await (await server.send(png)).json();
        assert.strictEqual(again.duplicate, true);
        assert.strictEqual(runs, 1, 'not computed for a duplicate');
        assert.deepStrictEqual((await documents.findBySha256(first.hash)).visual, stored);
    } finally { await server.close(); }
});
