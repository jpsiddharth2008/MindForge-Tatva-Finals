// Issue #56: helmet, CORS allowlist, rate limits, health, 404 and graceful shutdown.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const { fakeS3, start, loginToken, postFile, TEST_PASSWORD } = require('./helpers');
const { originsFromEnv, parseOrigins, installGracefulShutdown } = require('../security');
const { runChecks, chainChecks } = require('../health');
const { createLogger } = require('../logger');

const GOOD = 'https://registry.example.gov';
const EVIL = 'https://evil.com';
const FILE = Buffer.from('%PDF-1.4 hardening');

test('CORS: a disallowed origin is rejected with 403 and causes no side effect', async () => {
    const s3 = fakeS3();
    const api = await start(s3, { corsOrigins: [GOOD] });
    try {
        const { token } = await loginToken(api.url);
        const res = await fetch(`${api.url}/api/anchor`, { method: 'POST', headers: { Origin: EVIL, Authorization: `Bearer ${token}` },
            body: (() => { const f = new FormData(); f.append('file', new Blob([FILE]), 'a.pdf'); return f; })() });
        assert.strictEqual(res.status, 403);
        assert.strictEqual(res.headers.get('access-control-allow-origin'), null);
        assert.strictEqual(s3.sent.length, 0, 'the request must not have been processed');
        assert.strictEqual((await res.json()).error, 'Forbidden.');
    } finally { await api.close(); }
});

test('CORS: an allowed origin is echoed back, preflight works, and a disallowed preflight is refused', async () => {
    const api = await start(fakeS3(), { corsOrigins: [GOOD] });
    try {
        const ok = await postFile(`${api.url}/api/hash`, FILE);
        assert.strictEqual(ok.status, 200, 'no Origin header (curl, servers) is allowed');
        const withOrigin = await fetch(`${api.url}/api/health`, { headers: { Origin: GOOD } });
        assert.strictEqual(withOrigin.headers.get('access-control-allow-origin'), GOOD);
        const pre = await fetch(`${api.url}/api/anchor`, { method: 'OPTIONS',
            headers: { Origin: GOOD, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization' } });
        assert.ok(pre.status === 204 || pre.status === 200);
        assert.match(pre.headers.get('access-control-allow-headers'), /Authorization/i);
        const bad = await fetch(`${api.url}/api/anchor`, { method: 'OPTIONS', headers: { Origin: EVIL, 'Access-Control-Request-Method': 'POST' } });
        assert.strictEqual(bad.status, 403);
    } finally { await api.close(); }
});

test('CORS: the origin list is exact (no wildcard, no suffix tricks) and empty means nobody', async () => {
    const api = await start(fakeS3(), { corsOrigins: [GOOD] });
    const none = await start(fakeS3(), { corsOrigins: [] });
    try {
        for (const origin of [`${GOOD}.evil.com`, 'https://evil.com/registry.example.gov', 'http://registry.example.gov', 'null', '*']) {
            const res = await fetch(`${api.url}/api/health`, { headers: { Origin: origin } });
            assert.strictEqual(res.status, 403, `should refuse Origin: ${origin}`);
        }
        const res = await fetch(`${none.url}/api/health`, { headers: { Origin: GOOD } });
        assert.strictEqual(res.status, 403);
    } finally { await api.close(); await none.close(); }
});

test('CORS list from the environment: explicit, dev default, production default', () => {
    assert.deepStrictEqual(parseOrigins(' https://a.com/ , https://b.com,, '), ['https://a.com', 'https://b.com']);
    assert.deepStrictEqual(originsFromEnv({ CORS_ORIGINS: 'https://a.com' }), ['https://a.com']);
    assert.deepStrictEqual(originsFromEnv({}), ['http://localhost:5173', 'http://localhost:4173']);
    assert.deepStrictEqual(originsFromEnv({ NODE_ENV: 'production' }), [], 'production never defaults to open');
    assert.deepStrictEqual(originsFromEnv({ NODE_ENV: 'production', CORS_ORIGINS: '  ' }), []);
});

test('helmet headers are set and x-powered-by is gone', async () => {
    const api = await start();
    try {
        const res = await fetch(`${api.url}/api/health`);
        assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
        assert.ok(res.headers.get('strict-transport-security'));
        assert.ok(res.headers.get('x-frame-options') || res.headers.get('content-security-policy'));
        assert.strictEqual(res.headers.get('x-powered-by'), null);
    } finally { await api.close(); }
});

test('rate limit: rapid requests to /api/hash get 429 with a generic body, and other routes are unaffected', async () => {
    const api = await start(fakeS3(), { rateLimits: { files: { windowMs: 60000, limit: 3 } } });
    try {
        const codes = [];
        for (let i = 0; i < 5; i++) codes.push((await postFile(`${api.url}/api/hash`, FILE)).status);
        assert.deepStrictEqual(codes, [200, 200, 200, 429, 429]);
        const limited = await postFile(`${api.url}/api/hash`, FILE);
        const body = await limited.json();
        assert.strictEqual(body.error, 'Too many requests.');
        assert.ok(limited.headers.get('ratelimit') || limited.headers.get('ratelimit-policy'), 'clients are told the limit');
        assert.strictEqual((await fetch(`${api.url}/api/health`)).status, 200, 'health must stay reachable');
    } finally { await api.close(); }
});

test('rate limit: /api/anchor is limited too, before it reads the upload', async () => {
    const s3 = fakeS3();
    const api = await start(s3, { rateLimits: { files: { windowMs: 60000, limit: 2 } } });
    try {
        const { token } = await loginToken(api.url);
        const codes = [];
        for (let i = 0; i < 4; i++) codes.push((await postFile(`${api.url}/api/anchor`, FILE, { token })).status);
        assert.deepStrictEqual(codes, [200, 200, 429, 429]);
        assert.strictEqual(s3.sent.length, 2);
    } finally { await api.close(); }
});

test('rate limit: repeated wrong passwords are throttled, even for the right password afterwards', async () => {
    const api = await start(fakeS3(), { rateLimits: { login: { windowMs: 60000, limit: 3 } } });
    try {
        for (let i = 0; i < 3; i++) assert.strictEqual((await loginToken(api.url, 'registrar', 'wrong-password-123')).res.status, 401);
        assert.strictEqual((await loginToken(api.url, 'registrar', TEST_PASSWORD)).res.status, 429);
    } finally { await api.close(); }
});

test('a JSON body over 1 MB is refused with 413 and a generic message', async () => {
    const api = await start();
    try {
        const res = await fetch(`${api.url}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'x'.repeat(1.2 * 1024 * 1024), password: 'y' }) });
        assert.strictEqual(res.status, 413);
        assert.strictEqual((await res.json()).error, 'Request too large.');
    } finally { await api.close(); }
});

test('unknown routes get a JSON 404 with a request id', async () => {
    const api = await start();
    try {
        for (const [method, route] of [['GET', '/nope'], ['POST', '/upload'], ['GET', '/api/anchor']]) {
            const res = await fetch(`${api.url}${route}`, { method });
            assert.strictEqual(res.status, 404, `${method} ${route}`);
            const body = await res.json();
            assert.strictEqual(body.error, 'Not found.');
            assert.ok(body.requestId);
        }
    } finally { await api.close(); }
});

test('GET /api/health reports each component and exposes nothing sensitive', async () => {
    const api = await start();
    try {
        const res = await fetch(`${api.url}/api/health`);
        const body = await res.json();
        assert.strictEqual(res.status, 200);
        assert.strictEqual(body.status, 'ok');
        assert.deepStrictEqual(Object.keys(body.components).sort(), ['app', 'contract', 'mongodb', 'polygon_rpc', 's3_config']);
        assert.strictEqual(body.components.app, 'ok');
        assert.strictEqual(body.components.s3_config, 'ok');
        assert.strictEqual(body.components.mongodb, 'not_configured');
        assert.ok(!JSON.stringify(body).match(/test-bucket|ap-south-1|secret|key|http/i), 'no config values in the response');
    } finally { await api.close(); }
});

test('health: a failing dependency makes it 503 "degraded" and the reason is not exposed', async () => {
    const SECRET_URL = 'https://rpc.example.com/v2/SUPER-SECRET-API-KEY';
    const api = await start(fakeS3(), { health: {
        ...chainChecks({ RPC_URL: SECRET_URL, CONTRACT_ADDRESS: '0xabc' }, async () => { throw new Error(`connect refused ${SECRET_URL}`); }),
    } });
    try {
        const res = await fetch(`${api.url}/api/health`);
        const text = await res.text();
        assert.strictEqual(res.status, 503);
        assert.strictEqual(JSON.parse(text).status, 'degraded');
        assert.strictEqual(JSON.parse(text).components.polygon_rpc, 'down');
        assert.ok(!text.includes('SUPER-SECRET') && !text.includes('refused'), `leaked: ${text}`);
    } finally { await api.close(); }
});

test('health: chain checks use the RPC, report a contract with no bytecode as down, and skip when unconfigured', async () => {
    const reply = (result) => async () => ({ json: async () => ({ result }) });
    const env = { RPC_URL: 'https://rpc.test', CONTRACT_ADDRESS: '0xabc' };
    assert.deepStrictEqual(await runChecks(chainChecks(env, reply('0x10'))), { polygon_rpc: 'ok', contract: 'ok' });
    assert.deepStrictEqual(await runChecks(chainChecks(env, reply('0x'))), { polygon_rpc: 'ok', contract: 'down' });   // node answers, but no bytecode at the address
    assert.deepStrictEqual(await runChecks(chainChecks({}, reply('0x10'))), { polygon_rpc: 'not_configured', contract: 'not_configured' });
    const rpcError = async () => ({ json: async () => ({ error: { message: 'nope' } }) });
    assert.strictEqual((await runChecks(chainChecks(env, rpcError))).polygon_rpc, 'down');
});

test('health: a check that never answers is reported down after the timeout', async () => {
    const out = await runChecks({ stuck: () => new Promise(() => {}), fine: async () => 'ok' }, 50);
    assert.deepStrictEqual(out, { stuck: 'down', fine: 'ok' });
});

test('graceful shutdown: stops accepting, lets an in-flight request finish, then exits 0, once', async () => {
    const app = express();
    app.get('/slow', (req, res) => setTimeout(() => res.send('finished'), 300));
    const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
    const port = server.address().port;
    const exits = [];
    const exited = new Promise((resolve) => {
        const handler = installGracefulShutdown(server, createLogger({ logDir: null, silent: true }), {
            signals: [], exit: (code) => { exits.push(code); resolve(); },
        });
        server.shutdownNow = handler;
    });
    const inflight = fetch(`http://127.0.0.1:${port}/slow`, { headers: { Connection: 'close' } }).then((r) => r.text());
    await new Promise((r) => setTimeout(r, 50));
    server.shutdownNow('SIGTERM');
    server.shutdownNow('SIGTERM');                                   // second signal is ignored
    assert.strictEqual(await inflight, 'finished', 'the in-flight request completes');
    await exited;
    assert.deepStrictEqual(exits, [0]);
    await assert.rejects(() => new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/slow`, resolve);
        req.on('error', reject);
    }), 'new connections are refused');
});

test('graceful shutdown: a stuck server is force-exited with code 1 after the timeout', async () => {
    const server = { close: () => {}, closeIdleConnections: () => {} };   // close() never calls back
    const exits = [];
    const done = new Promise((resolve) => {
        const handler = installGracefulShutdown(server, createLogger({ logDir: null, silent: true }), {
            signals: [], timeoutMs: 50, exit: (code) => { exits.push(code); resolve(); },
        });
        handler('SIGTERM');
    });
    await done;
    assert.deepStrictEqual(exits, [1]);
});
