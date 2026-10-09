// Issue #57: credentials must never reach logs or clients.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLogger, redact, scrubString, REDACTED } = require('../logger');
const { fakeS3, memoryLogger, start, loginToken, postFile, TEST_AUTH, TEST_PASSWORD } = require('./helpers');

// Realistic-looking secrets, built so they are not real credentials.
const MONGO_URI = 'mongodb+srv://dbadmin:Sup3rS3cretPw@cluster0.ab1cd.mongodb.net/mindforge?retryWrites=true';
const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';
const PRIV_KEY = '0x' + 'ab12'.repeat(16);
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl';

// The issue's own check, as a function.
const LEAK = /mongodb\+srv|Sup3rS3cretPw|AKIA[0-9A-Z]{16}|0x[a-f0-9]{64}|eyJ[A-Za-z0-9_-]+\./;

test('scrubString removes secrets embedded in free text', () => {
    for (const secret of [MONGO_URI, AWS_KEY, PRIV_KEY, JWT]) {
        const out = scrubString(`connect failed for ${secret} after 3 retries`);
        assert.ok(!out.includes(secret), `still contains: ${secret}`);
        assert.ok(out.includes('after 3 retries'), 'surrounding text is kept');
    }
    assert.ok(!scrubString('header was Authorization: Bearer abc.def.ghi123').includes('abc.def'));
    assert.ok(!scrubString('password=hunter2 and token: abc123').match(/hunter2|abc123/));
});

test('redact blanks secret-named keys at any depth, in arrays, and survives cycles', () => {
    const cyc = { name: 'loop' };
    cyc.self = cyc;
    const out = redact({
        password: 'p', Authorization: 'Bearer x', privateKey: PRIV_KEY, mongoUri: MONGO_URI,
        nested: { deep: { apiKey: 'k', fine: 'visible' } }, list: [{ token: 't' }, 'ok'], cyc,
    });
    assert.strictEqual(out.password, REDACTED);
    assert.strictEqual(out.Authorization, REDACTED);
    assert.strictEqual(out.privateKey, REDACTED);
    assert.strictEqual(out.nested.deep.apiKey, REDACTED);
    assert.strictEqual(out.nested.deep.fine, 'visible');
    assert.strictEqual(out.list[0].token, REDACTED);
    assert.strictEqual(out.list[1], 'ok');
    assert.strictEqual(out.cyc.self, '[Circular]');
    assert.ok(!JSON.stringify(out).match(LEAK));
});

test('errors are reduced to name, message and code: no stack, no extra properties', () => {
    const err = new Error(`connect ECONNREFUSED ${MONGO_URI}`);
    err.code = 'ECONNREFUSED';
    err.config = { uri: MONGO_URI, password: 'x' };      // the kind of property driver errors carry
    const out = redact(err);
    assert.deepStrictEqual(Object.keys(out).sort(), ['code', 'message', 'name']);
    assert.ok(!JSON.stringify(out).match(LEAK));
    assert.ok(!('stack' in out));
});

test('file contents are never logged', () => {
    const out = redact({ file: Buffer.from('TOP-SECRET-DOCUMENT-CONTENT') });
    assert.ok(!JSON.stringify(out).includes('TOP-SECRET'));
    assert.match(out.file, /Buffer 27 bytes/);
});

test('the logger redacts the message and every field before writing', () => {
    const { logger, lines } = memoryLogger();
    logger.error(`db down: ${MONGO_URI}`, { err: new Error(MONGO_URI), password: 'hunter2', note: AWS_KEY });
    logger.info('login', { token: JWT, user: 'registrar' });
    assert.strictEqual(lines.length, 2);
    for (const line of lines) assert.ok(!line.match(LEAK) && !line.includes('hunter2'), `leaked: ${line}`);
    assert.ok(lines[1].includes('registrar'), 'non-secret data is still logged');
});

test('a failing upload returns a generic message, a request id, and logs nothing sensitive', async () => {
    const s3 = { send: async () => { throw new Error(`S3 exploded for bucket secret-vault ${MONGO_URI} key ${AWS_KEY}`); } };
    const { logger, lines } = memoryLogger();
    const api = await start(s3, { logger });
    try {
        const { token } = await loginToken(api.url);
        const res = await postFile(`${api.url}/api/anchor`, Buffer.from('%PDF-1.4 TOP-SECRET-DOCUMENT-CONTENT'), { token });
        const text = await res.text();
        const body = JSON.parse(text);
        assert.strictEqual(res.status, 500);
        assert.strictEqual(body.error, 'Internal server error.');
        assert.ok(!text.match(/exploded|secret-vault|mongodb|AKIA|Upload Failed/), `client saw internals: ${text}`);
        assert.strictEqual(res.headers.get('x-request-id'), body.requestId, 'header and body carry the same id');
        const logged = lines.join('\n');
        assert.ok(logged.includes(body.requestId), 'the failure is findable by request id');
        assert.ok(logged.includes('exploded'), 'operators still get the cause');
        assert.ok(!logged.match(LEAK), `log leaked: ${logged}`);
        assert.ok(!logged.includes('TOP-SECRET'), 'document contents must not be logged');
    } finally { await api.close(); }
});

test('no stack trace reaches the client, in production or development', async () => {
    const s3 = { send: async () => { throw new Error('boom'); } };
    for (const env of ['production', 'development']) {
        const previous = process.env.NODE_ENV;
        process.env.NODE_ENV = env;
        const api = await start(s3);
        try {
            const { token } = await loginToken(api.url);
            const text = await (await postFile(`${api.url}/api/anchor`, Buffer.from('%PDF-x'), { token })).text();
            assert.ok(!text.match(/at .*\.js|stack|node_modules/i), `stack leaked in ${env}: ${text}`);
        } finally { await api.close(); process.env.NODE_ENV = previous; }
    }
});

test('request logs carry method, path and status but never the query string, headers or body', async () => {
    const { logger, lines } = memoryLogger();
    const api = await start(fakeS3(), { logger });
    try {
        const { token } = await loginToken(api.url);
        await postFile(`${api.url}/api/hash?access_token=${JWT}`, Buffer.from('%PDF-1.4 TOP-SECRET-DOCUMENT-CONTENT'), { token });
        await fetch(`${api.url}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'registrar', password: 'a-wrong-password-9' }) });
        const logged = lines.join('\n');
        assert.match(logged, /"path":"\/api\/hash"/);
        assert.match(logged, /"status":401/);
        for (const banned of [JWT, 'access_token', 'TOP-SECRET', 'a-wrong-password-9', TEST_PASSWORD, token]) {
            assert.ok(!logged.includes(banned), `request log contains ${banned.slice(0, 12)}...`);
        }
    } finally { await api.close(); }
});

test('malformed JSON gets a 400 with a generic message, not the parser error', async () => {
    const api = await start();
    try {
        const res = await fetch(`${api.url}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"username": ' });
        assert.strictEqual(res.status, 400);
        const body = await res.json();
        assert.strictEqual(body.error, 'Bad request.');
        assert.ok(body.requestId);
    } finally { await api.close(); }
});

test('rotating file transport: 5 MB x 3 files, and a real write contains no secrets (the issue\'s grep check)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-'));
    const logger = createLogger({ logDir: dir, silent: true });
    const file = logger.transports.find((t) => t.filename);
    assert.strictEqual(file.maxsize, 5 * 1024 * 1024);
    assert.strictEqual(file.maxFiles, 3);
    logger.error(`conn failed ${MONGO_URI}`, { err: new Error(`${AWS_KEY} ${PRIV_KEY}`), jwt: JWT, password: 'hunter2' });
    await new Promise((resolve) => { logger.on('finish', resolve); logger.end(); });
    const written = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
    assert.ok(written.includes('conn failed'), 'something was written');
    assert.ok(!written.match(LEAK) && !written.includes('hunter2'), `file contains secrets: ${written}`);
});
