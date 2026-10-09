// Issue #51: content-addressed keys, encryption at rest, signed links, bucket audit.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { S3Client } = require('@aws-sdk/client-s3');
const { createStorage, presignTtlFromEnv, sseFromEnv, MAX_PRESIGN_SECONDS } = require('../storage');
const { auditBucket, applyFixes } = require('../scripts/check-bucket');
const { fakeS3, start, loginToken, postFile } = require('./helpers');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const pdf = (text) => Buffer.from(`%PDF-1.4\n${text}\n`);

test('two different files both named degree.pdf survive, under distinct keys', async () => {
    const s3 = fakeS3();
    const api = await start(s3);
    try {
        const { token } = await loginToken(api.url);
        const a = pdf('degree of Asha Rao'), b = pdf('degree of Ravi Menon');
        const ra = await (await postFile(`${api.url}/api/anchor`, a, { name: 'degree.pdf', token })).json();
        const rb = await (await postFile(`${api.url}/api/anchor`, b, { name: 'degree.pdf', token })).json();
        assert.notStrictEqual(ra.s3Key, rb.s3Key);
        assert.strictEqual(ra.s3Key, sha(a));
        assert.strictEqual(rb.s3Key, sha(b));
        assert.strictEqual(ra.hash, ra.s3Key, 'the hash returned to the client is the key');
        assert.deepStrictEqual(s3.sent.map((c) => c.input.Key), [sha(a), sha(b)]);
    } finally { await api.close(); }
});

test('every write is encrypted (ServerSideEncryption) and conditional (IfNoneMatch)', async () => {
    const s3 = fakeS3();
    const api = await start(s3);
    try {
        const { token } = await loginToken(api.url);
        await postFile(`${api.url}/api/anchor`, pdf('x'), { token });
        const input = s3.sent[0].input;
        assert.strictEqual(input.ServerSideEncryption, 'AES256');
        assert.strictEqual(input.IfNoneMatch, '*', 'never overwrite an existing object');
        assert.strictEqual(input.Bucket, 'test-bucket');
    } finally { await api.close(); }
});

test('uploading the same bytes again is deduplicated, not an error', async () => {
    const exists = Object.assign(new Error('exists'), { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } });
    let calls = 0;
    const s3 = { send: async () => { calls++; if (calls > 1) throw exists; return {}; } };
    const api = await start(s3);
    try {
        const { token } = await loginToken(api.url);
        const first = await (await postFile(`${api.url}/api/anchor`, pdf('same'), { token })).json();
        const second = await postFile(`${api.url}/api/anchor`, pdf('same'), { token });
        assert.strictEqual(second.status, 200);
        const body = await second.json();
        assert.strictEqual(first.alreadyStored, false);
        assert.strictEqual(body.alreadyStored, true);
        assert.strictEqual(body.s3Key, first.s3Key);
    } finally { await api.close(); }
});

test('other S3 failures are still errors (generic 500), not mistaken for "already stored"', async () => {
    const denied = Object.assign(new Error('AccessDenied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
    const api = await start({ send: async () => { throw denied; } });
    try {
        const { token } = await loginToken(api.url);
        const res = await postFile(`${api.url}/api/anchor`, pdf('y'), { token });
        assert.strictEqual(res.status, 500);
        assert.strictEqual((await res.json()).error, 'Internal server error.');
    } finally { await api.close(); }
});

test('the response carries a signed, expiring link and never the public bucket URL', async () => {
    const api = await start(fakeS3());
    try {
        const { token } = await loginToken(api.url);
        const body = await (await postFile(`${api.url}/api/anchor`, pdf('z'), { token })).json();
        assert.ok(body.url.includes('X-Amz-Signature'));
        assert.strictEqual(body.urlExpiresInSeconds, 300);
        assert.ok(!/amazonaws\.com\/[^?]*$/.test(body.url), 'no unsigned public URL');
    } finally { await api.close(); }
});

test('a real presigned URL (signed offline) is for this bucket and key, expires within 5 minutes, and is signed', async () => {
    const s3 = new S3Client({ region: 'ap-south-1', credentials: { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'exampleSecretexampleSecretexample1234' } });
    const storage = createStorage({ s3, bucketName: 'citizen-docs', presignTtlSeconds: 9999 });   // asks for more than allowed
    const hash = sha(pdf('real'));
    const { url, expiresInSeconds } = await storage.signedUrl(hash);
    const u = new URL(url);
    assert.strictEqual(u.hostname, 'citizen-docs.s3.ap-south-1.amazonaws.com');
    assert.strictEqual(u.pathname, `/${hash}`);
    assert.strictEqual(u.searchParams.get('X-Amz-Expires'), '300');
    assert.strictEqual(expiresInSeconds, 300);
    assert.ok(u.searchParams.get('X-Amz-Signature'));
    assert.ok(!url.includes('exampleSecret'), 'the secret key is never in the URL');
});

test('signed-link lifetime is capped at 300 s, floored at 1 s, and junk falls back to the maximum', () => {
    assert.strictEqual(presignTtlFromEnv({ PRESIGN_TTL_SECONDS: '60' }), 60);
    assert.strictEqual(presignTtlFromEnv({ PRESIGN_TTL_SECONDS: '9999' }), MAX_PRESIGN_SECONDS);
    for (const bad of [undefined, '', 'abc', '0', '-3']) assert.strictEqual(presignTtlFromEnv({ PRESIGN_TTL_SECONDS: bad }), 300, String(bad));
    const seen = [];
    const st = createStorage({ s3: {}, bucketName: 'b', presignTtlSeconds: 86400, presign: async (c, ttl) => { seen.push(ttl); return 'u'; } });
    return st.signedUrl('k').then(() => assert.deepStrictEqual(seen, [300]));
});

test('KMS mode adds the key id; a bad mode is refused at start-up; env parsing', async () => {
    const sent = [];
    const st = createStorage({ s3: { send: async (c) => sent.push(c) }, bucketName: 'b', sse: { mode: 'aws:kms', kmsKeyId: 'arn:aws:kms:ap-south-1:111122223333:key/abc' } });
    await st.store({ hash: sha('k'), buffer: pdf('k'), contentType: 'application/pdf', originalName: 'k.pdf' });
    assert.strictEqual(sent[0].input.ServerSideEncryption, 'aws:kms');
    assert.match(sent[0].input.SSEKMSKeyId, /^arn:aws:kms/);
    assert.throws(() => createStorage({ s3: {}, bucketName: 'b', sse: { mode: 'none' } }), /S3_SSE/);
    assert.deepStrictEqual(sseFromEnv({}), { mode: 'AES256', kmsKeyId: undefined });
    assert.deepStrictEqual(sseFromEnv({ S3_SSE: 'aws:kms', S3_KMS_KEY_ID: 'k' }), { mode: 'aws:kms', kmsKeyId: 'k' });
});

test('store refuses anything that is not a SHA-256 hex key', async () => {
    const st = createStorage({ s3: { send: async () => ({}) }, bucketName: 'b' });
    for (const bad of ['../../etc/passwd', 'degree.pdf', 'ABC', sha('x').toUpperCase(), '']) {
        await assert.rejects(() => st.store({ hash: bad, buffer: pdf('x'), contentType: 'application/pdf', originalName: 'x.pdf' }), /SHA-256/);
    }
});

// ---- bucket audit (the "Block Public Access" and versioning checkboxes) ----
function bucketClient(config) {
    return { send: async (cmd) => {
        const name = cmd.constructor.name;
        if (name === 'GetPublicAccessBlockCommand') { if (!config.pab) throw Object.assign(new Error('x'), { name: 'NoSuchPublicAccessBlockConfiguration' }); return { PublicAccessBlockConfiguration: config.pab }; }
        if (name === 'GetBucketVersioningCommand') return { Status: config.versioning };
        if (name === 'GetBucketEncryptionCommand') { if (!config.enc) throw Object.assign(new Error('x'), { name: 'ServerSideEncryptionConfigurationNotFoundError' }); return { ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: config.enc } }] } }; }
        throw new Error(`unexpected ${name}`);
    } };
}
const ALL = { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true };

test('bucket audit: a correctly configured bucket passes all three checks', async () => {
    const r = await auditBucket(bucketClient({ pab: ALL, versioning: 'Enabled', enc: 'AES256' }), 'b');
    assert.deepStrictEqual(r.map((x) => x.ok), [true, true, true]);
});

test('bucket audit: partial public access block, no versioning and no encryption are each flagged', async () => {
    const r = await auditBucket(bucketClient({ pab: { ...ALL, BlockPublicPolicy: false }, versioning: undefined, enc: null }), 'b');
    assert.deepStrictEqual(r.map((x) => x.ok), [false, false, false]);
    const none = await auditBucket(bucketClient({ pab: null, versioning: 'Suspended', enc: 'AES256' }), 'b');
    assert.deepStrictEqual(none.map((x) => x.ok), [false, false, true], 'a missing public-access-block config counts as NOT blocked');
});

test('bucket fix applies all three settings', async () => {
    const sent = [];
    await applyFixes({ send: async (c) => { sent.push([c.constructor.name, c.input]); return {}; } }, 'b');
    assert.deepStrictEqual(sent.map((x) => x[0]), ['PutPublicAccessBlockCommand', 'PutBucketVersioningCommand', 'PutBucketEncryptionCommand']);
    assert.deepStrictEqual(sent[0][1].PublicAccessBlockConfiguration, ALL);
    assert.strictEqual(sent[1][1].VersioningConfiguration.Status, 'Enabled');
});
