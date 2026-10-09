// Runs the forgery corpus (../corpus) through the REAL verification pipeline: a real MongoDB (in memory), real OCR, real perceptual
// hashing, the real routes. Only the chain is scripted (the real chain layer is tested against a real EVM in blockchain/test).
//
// Used by test/corpus.test.js and by `npm run corpus`. With `overrideDir`, any file in that directory that has the same name as a
// corpus file REPLACES it, so real captures (a printed and photographed A1, a real WhatsApp round trip) are judged by exactly the
// same expectations. See corpus/CAPTURE.md.
const fs = require('node:fs');
const path = require('node:path');
const { startMongo } = require('./mongo');
const { fakeS3, start, loginToken } = require('./helpers');
const { fakeChain, mineAnchor, ADDR, tx } = require('./chain-fakes');

const CORPUS_DIR = path.join(__dirname, '..', '..', 'corpus');
const CHAIN_ID = 80002;

const sniff = (b) => (b[0] === 0xff && b[1] === 0xd8 ? 'image/jpeg' : b[0] === 0x89 ? 'image/png' : 'application/pdf');
const sameSet = (a, b) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

function readManifest(corpusDir = CORPUS_DIR) {
    return JSON.parse(fs.readFileSync(path.join(corpusDir, 'manifest.json'), 'utf8'));
}

/** What a sample must satisfy beyond its verdict: the right fields named, the right region flagged. */
function evaluate(sample, body) {
    const checks = [{ name: 'verdict', ok: body.verdict === sample.expectedVerdict, detail: `expected ${sample.expectedVerdict}, got ${body.verdict}` }];
    if (sample.tamperedFields) {
        const diffs = (body.tiers && body.tiers.content && body.tiers.content.fieldDiffs) || [];
        const want = sample.tamperedFields.map((f) => f.field);
        checks.push({ name: 'fields named', ok: sameSet(diffs.map((d) => d.field), want), detail: `expected ${want.join(', ')}; named ${diffs.map((d) => d.field).join(', ') || 'none'}` });
        const presented = Object.fromEntries(diffs.map((d) => [d.field, d.presented]));
        const wrong = sample.tamperedFields.filter((f) => presented[f.field] !== f.presented);
        checks.push({ name: 'values read', ok: wrong.length === 0, detail: wrong.length ? wrong.map((f) => `${f.field}: expected "${f.presented}", read "${presented[f.field]}"`).join('; ') : 'every altered value read correctly' });
    }
    if (sample.tamperedRegions) {
        const changed = (body.tiers && body.tiers.visual && body.tiers.visual.changedRegions) || [];
        const want = sample.tamperedRegions.map((r) => r.region);
        checks.push({ name: 'region flagged', ok: want.every((r) => changed.includes(r)), detail: `expected ${want.join(', ')}; flagged ${changed.join(', ') || 'none'}` });
    }
    return checks;
}

/**
 * @param {{corpusDir?: string, overrideDir?: string|null, only?: string[]|null}} options  only: judge just these files (the base document is always issued)
 * @returns {Promise<{results: Array, matrix: object, manifest: object}>}
 */
async function runCorpus({ corpusDir = CORPUS_DIR, overrideDir = null, only = null } = {}) {
    const manifest = readManifest(corpusDir);
    const mongo = await startMongo();
    let server;
    try {
        const chain = fakeChain();
        server = await start(fakeS3(), {
            documents: mongo.documents, audit: mongo.audit, chain, contractAddress: ADDR, chainId: CHAIN_ID,
            rateLimits: { verify: { windowMs: 60000, limit: 100000 }, files: { windowMs: 60000, limit: 100000 } },
        });
        const { token } = await loginToken(server.url);
        const pick = (file) => {
            const over = overrideDir && path.join(overrideDir, file);
            return over && fs.existsSync(over) ? { bytes: fs.readFileSync(over), real: true } : { bytes: fs.readFileSync(path.join(corpusDir, 'files', file)), real: false };
        };

        // 1. issue the base document, exactly as an officer would (the printed text is read back and must agree with the details)
        const base = pick(manifest.baseDocument);
        const form = new FormData();
        form.append('file', new Blob([base.bytes], { type: sniff(base.bytes) }), manifest.baseDocument);
        form.append('fields', JSON.stringify(manifest.anchoredFields));
        const up = await fetch(`${server.url}/api/anchor`, { method: 'POST', body: form, headers: { Authorization: `Bearer ${token}` } });
        const issued = await up.json();
        if (up.status !== 200) throw new Error(`the base document could not be issued (${up.status}): ${JSON.stringify(issued)}`);
        const call = (route, body) => fetch(`${server.url}${route}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        mineAnchor(chain, issued.document, tx(1));
        await call(`/api/documents/${issued.document.documentId}/chain-pending`, { transactionHash: tx(1) });
        const confirmed = await (await call(`/api/documents/${issued.document.documentId}/chain-confirmed`, { transactionHash: tx(1) })).json();
        if (!confirmed.document || confirmed.document.status !== 'ISSUED') throw new Error(`the base document did not reach ISSUED: ${JSON.stringify(confirmed)}`);
        if (issued.contentHash !== manifest.anchoredContentHash) throw new Error('the anchored content hash differs from the manifest: the base document or its fields changed');

        // 2. verify every sample as a member of the public would
        const results = [];
        for (const sample of manifest.samples.filter((x) => !only || only.includes(x.file))) {
            const { bytes, real } = pick(sample.file);
            const f = new FormData();
            f.append('file', new Blob([bytes], { type: sniff(bytes) }), sample.file);
            const res = await fetch(`${server.url}/api/verify`, { method: 'POST', body: f });
            const body = await res.json();
            const checks = res.status === 200 ? evaluate(sample, body) : [{ name: 'request', ok: false, detail: `HTTP ${res.status}: ${JSON.stringify(body)}` }];
            results.push({
                file: sample.file, group: sample.group, severity: sample.severity || null, manipulation: sample.manipulation || null,
                simulated: !!sample.simulated && !real, real, expected: sample.expectedVerdict, actual: body.verdict || `HTTP ${res.status}`,
                confidence: body.confidence || null, reason: body.reason || null, checks, ok: checks.every((c) => c.ok),
            });
        }

        const matrix = {};
        for (const r of results) { matrix[r.expected] = matrix[r.expected] || {}; matrix[r.expected][r.actual] = (matrix[r.expected][r.actual] || 0) + 1; }
        return { results, matrix, manifest };
    } finally {
        if (server) await server.close();
        await mongo.stop();
    }
}

/** A readable report: one line per sample, the confusion matrix, and a summary that says how much of it is simulated. */
function formatReport({ results, matrix }) {
    const pad = (s, n) => String(s).padEnd(n);
    const lines = [pad('file', 26) + pad('group', 10) + pad('expected', 20) + pad('actual', 20) + 'result'];
    for (const r of results) {
        const flag = r.real ? ' (REAL capture)' : r.simulated ? ' (simulated)' : '';
        const bad = r.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join(' | ');
        lines.push(pad(r.file, 26) + pad(r.group, 10) + pad(r.expected, 20) + pad(r.actual, 20) + (r.ok ? 'ok' : `FAIL ${bad}`) + flag);
    }
    const verdicts = [...new Set(results.flatMap((r) => [r.expected, r.actual]))].sort();
    lines.push('', 'Confusion matrix (rows: expected, columns: actual)', pad('', 20) + verdicts.map((v) => pad(v.replace('AUTHENTIC_', 'AUTH_'), 17)).join(''));
    for (const exp of Object.keys(matrix).sort()) lines.push(pad(exp, 20) + verdicts.map((v) => pad(matrix[exp][v] || '.', 17)).join(''));
    const by = (g) => { const rs = results.filter((r) => r.group === g); return `${rs.filter((r) => r.ok).length}/${rs.length}`; };
    const real = results.filter((r) => r.real).length;
    const sim = results.filter((r) => r.simulated).length;
    lines.push('', `genuine ${by('genuine')} · tampered ${by('tampered')} · negative controls ${by('negative')}`,
        `${real} real capture(s), ${sim} simulated, ${results.length - real - sim} digital. Simulated captures are evidence, not proof, that real phones behave the same.`);
    return lines.join('\n');
}

module.exports = { runCorpus, formatReport, readManifest, evaluate, CORPUS_DIR };
