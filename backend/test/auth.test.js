// Step 0: issuance needs a real login; verification stays public.
const test = require('node:test');
const assert = require('node:assert');
const jwt = require('jsonwebtoken');
const { createAuth, validateAuthConfig } = require('../auth');
const { TEST_AUTH, TEST_PASSWORD, fakeS3, start, loginToken, postFile } = require('./helpers');

const FILE = Buffer.from('%PDF-1.4 certificate');

test('correct credentials return a token that verifies', async () => {
    const api = await start();
    try {
        const { res, token } = await loginToken(api.url);
        assert.strictEqual(res.status, 200);
        const claims = jwt.verify(token, TEST_AUTH.jwtSecret, { algorithms: ['HS256'], issuer: 'mindforge' });
        assert.strictEqual(claims.sub, 'registrar');
        assert.ok(claims.exp - claims.iat <= 8 * 3600, 'token lifetime is capped');
    } finally { await api.close(); }
});

test('wrong password, wrong username and missing fields all get the same 401', async () => {
    const api = await start();
    try {
        const bodies = [
            { username: 'registrar', password: 'wrong password!!' },
            { username: 'someone-else', password: TEST_PASSWORD },
            { username: 'registrar' }, {}, { username: 123, password: ['x'] },
        ];
        const texts = new Set();
        for (const b of bodies) {
            const res = await fetch(`${api.url}/api/auth/login`, { method: 'POST',
                headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
            assert.strictEqual(res.status, 401);
            texts.add(await res.text());
        }
        assert.strictEqual(texts.size, 1, 'the response must not reveal which part was wrong');
    } finally { await api.close(); }
});

test('the old client-side password is not accepted by the server', async () => {
    const api = await start();
    try {
        const { res } = await loginToken(api.url, 'registrar', 'admin123');
        assert.strictEqual(res.status, 401);
    } finally { await api.close(); }
});

test('/api/anchor without a token is 401 and writes nothing', async () => {
    const s3 = fakeS3();
    const api = await start(s3);
    try {
        const res = await postFile(`${api.url}/api/anchor`, FILE);
        assert.strictEqual(res.status, 401);
        assert.strictEqual(s3.sent.length, 0);
    } finally { await api.close(); }
});

test('/api/anchor rejects garbage, expired, wrong-secret, wrong-issuer, wrong-algorithm and alg:none tokens', async () => {
    const s3 = fakeS3();
    const api = await start(s3);
    try {
        const opts = { issuer: 'mindforge' };
        const bad = [
            'not-a-jwt',
            jwt.sign({ sub: 'registrar' }, TEST_AUTH.jwtSecret, { ...opts, expiresIn: -10 }),
            jwt.sign({ sub: 'registrar' }, 'a-different-secret-a-different-secret!!', { ...opts, expiresIn: '1h' }),
            jwt.sign({ sub: 'registrar' }, TEST_AUTH.jwtSecret, { issuer: 'someone-else', expiresIn: '1h' }),
            jwt.sign({ sub: 'registrar' }, TEST_AUTH.jwtSecret, { ...opts, algorithm: 'HS512', expiresIn: '1h' }),
            Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url') + '.'
                + Buffer.from(JSON.stringify({ sub: 'registrar', iss: 'mindforge' })).toString('base64url') + '.',
        ];
        for (const token of bad) {
            const res = await postFile(`${api.url}/api/anchor`, FILE, { token });
            assert.strictEqual(res.status, 401, `token should be rejected: ${token.slice(0, 20)}`);
        }
        assert.strictEqual(s3.sent.length, 0);
    } finally { await api.close(); }
});

test('/api/anchor with a valid token stores the file once', async () => {
    const s3 = fakeS3();
    const api = await start(s3);
    try {
        const { token } = await loginToken(api.url);
        const res = await postFile(`${api.url}/api/anchor`, FILE, { token });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(s3.sent.length, 1);
    } finally { await api.close(); }
});

test('/api/hash stays public (citizen verification needs no login)', async () => {
    const api = await start();
    try {
        const res = await postFile(`${api.url}/api/hash`, FILE);
        assert.strictEqual(res.status, 200);
    } finally { await api.close(); }
});

test('the app cannot be built with a weak or missing auth configuration', () => {
    const good = TEST_AUTH;
    assert.doesNotThrow(() => validateAuthConfig(good));
    for (const bad of [undefined, {}, { ...good, jwtSecret: 'short' }, { ...good, jwtSecret: undefined },
        { ...good, adminUsername: '' }, { ...good, adminPasswordHash: 'admin123' }, { ...good, adminPasswordHash: undefined }]) {
        assert.throws(() => createAuth(bad), /Invalid auth configuration/);
    }
});

test('config errors name the setting but never echo secret values', () => {
    try {
        createAuth({ ...TEST_AUTH, jwtSecret: 'hunter2-too-short' });
        assert.fail('should throw');
    } catch (e) {
        assert.ok(!e.message.includes('hunter2'), 'secret leaked into error');
        assert.match(e.message, /JWT_SECRET/);
    }
});
