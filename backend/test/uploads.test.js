// Issue #55: only real PDFs, PNGs and JPEGs, within the size limit, with a safe name.
const test = require('node:test');
const assert = require('node:assert');
const { sanitizeFilename, maxMbFromEnv } = require('../uploads');
const { fakeS3, memoryLogger, start, loginToken, postFile } = require('./helpers');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10, 0x4A, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xFF, 0xD9]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n');
const EXE = Buffer.concat([Buffer.from('MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00\xff\xff', 'latin1'), Buffer.alloc(64)]);

const post = (api, route, bytes, opts) => postFile(`${api.url}${route}`, bytes, opts);

test('real PDF, PNG and JPEG are accepted on both routes', async () => {
    const s3 = fakeS3();
    const api = await start(s3);
    try {
        const { token } = await loginToken(api.url);
        for (const [bytes, type, name] of [[PDF, 'application/pdf', 'a.pdf'], [PNG, 'image/png', 'a.png'], [JPEG, 'image/jpeg', 'a.jpg']]) {
            assert.strictEqual((await post(api, '/api/hash', bytes, { type, name })).status, 200, `hash ${name}`);
            assert.strictEqual((await post(api, '/api/anchor', bytes, { type, name, token })).status, 200, `anchor ${name}`);
        }
        assert.strictEqual(s3.sent.length, 3);
    } finally { await api.close(); }
});

test('an .exe renamed to .pdf is rejected (declared as a PDF, real content is not)', async () => {
    const s3 = fakeS3();
    const api = await start(s3);
    try {
        const { token } = await loginToken(api.url);
        for (const route of ['/api/hash', '/api/anchor']) {
            const res = await post(api, route, EXE, { name: 'invoice.pdf', type: 'application/pdf', token });
            assert.strictEqual(res.status, 400, route);
            assert.match((await res.json()).error, /not a supported type/);
        }
        assert.strictEqual(s3.sent.length, 0, 'nothing may reach S3');
    } finally { await api.close(); }
});

test('disguised content is rejected: HTML as .png, text as .pdf, empty file, zero bytes', async () => {
    const api = await start();
    try {
        const cases = [
            [Buffer.from('<html><script>alert(1)</script></html>'), 'image/png', 'x.png'],
            [Buffer.from('just some text'), 'application/pdf', 'x.pdf'],
            [Buffer.alloc(4096), 'application/pdf', 'x.pdf'],
            [Buffer.alloc(0), 'application/pdf', 'x.pdf'],
        ];
        for (const [bytes, type, name] of cases) {
            const res = await post(api, '/api/hash', bytes, { type, name });
            assert.strictEqual(res.status, 400, name);
        }
    } finally { await api.close(); }
});

test('a wrong declared type is rejected before the content is read', async () => {
    const api = await start();
    try {
        for (const type of ['text/html', 'application/x-msdownload', 'application/octet-stream', 'image/gif', 'image/svg+xml']) {
            const res = await post(api, '/api/hash', PDF, { type, name: 'a.pdf' });
            assert.strictEqual(res.status, 400, type);
            assert.match((await res.json()).error, /Unsupported file type/);
        }
    } finally { await api.close(); }
});

test('real content that disagrees with the declared type is rejected (a PNG sent as a PDF)', async () => {
    const api = await start();
    try {
        const res = await post(api, '/api/hash', PNG, { type: 'application/pdf', name: 'a.pdf' });
        assert.strictEqual(res.status, 400);
        assert.match((await res.json()).error, /does not match its declared type/);
    } finally { await api.close(); }
});

test('an oversized file gets 413 and the process keeps serving (limit 1 MB, sent 5 MB)', async () => {
    const s3 = fakeS3();
    const api = await start(s3, { maxFileSizeMb: 1 });
    try {
        const { token } = await loginToken(api.url);
        const big = Buffer.concat([PDF, Buffer.alloc(5 * 1024 * 1024)]);
        for (const route of ['/api/hash', '/api/anchor']) {
            const res = await post(api, route, big, { token });
            assert.strictEqual(res.status, 413, route);
            assert.match((await res.json()).error, /limit is 1 MB/);
        }
        assert.strictEqual(s3.sent.length, 0);
        assert.strictEqual((await post(api, '/api/hash', PDF)).status, 200, 'still healthy afterwards');
        assert.strictEqual((await fetch(`${api.url}/api/health`)).status, 200);
    } finally { await api.close(); }
});

test('a 100 MB upload is rejected with 413 and the process keeps serving', async () => {
    const api = await start(fakeS3());
    try {
        const big = Buffer.concat([PDF, Buffer.alloc(100 * 1024 * 1024)]);
        assert.strictEqual((await post(api, '/api/hash', big)).status, 413);
        assert.strictEqual((await post(api, '/api/hash', PDF)).status, 200);
    } finally { await api.close(); }
});

test('a file exactly at the limit is accepted', async () => {
    const api = await start(fakeS3(), { maxFileSizeMb: 1 });
    try {
        const exact = Buffer.concat([PDF, Buffer.alloc(1024 * 1024 - PDF.length)]);
        assert.strictEqual(exact.length, 1024 * 1024);
        assert.strictEqual((await post(api, '/api/hash', exact)).status, 200);
        const over = Buffer.concat([exact, Buffer.from('x')]);
        assert.strictEqual((await post(api, '/api/hash', over)).status, 413, 'one byte over is refused');
    } finally { await api.close(); }
});

test('more than one file, or the wrong field name, is a 400', async () => {
    const api = await start();
    try {
        const two = new FormData();
        two.append('file', new Blob([PDF], { type: 'application/pdf' }), 'a.pdf');
        two.append('file', new Blob([PDF], { type: 'application/pdf' }), 'b.pdf');
        assert.strictEqual((await fetch(`${api.url}/api/hash`, { method: 'POST', body: two })).status, 400);
        const wrong = new FormData();
        wrong.append('document', new Blob([PDF], { type: 'application/pdf' }), 'a.pdf');
        assert.strictEqual((await fetch(`${api.url}/api/hash`, { method: 'POST', body: wrong })).status, 400);
    } finally { await api.close(); }
});

test('what is stored: sanitised name as the key, the DETECTED type as ContentType, and a safe URL', async () => {
    const s3 = fakeS3();
    const api = await start(s3);
    try {
        const { token } = await loginToken(api.url);
        const res = await post(api, '/api/anchor', PNG, { name: '../../etc/pass wd<script>.png', type: 'image/png', token });
        assert.strictEqual(res.status, 200);
        const input = s3.sent[0].input;
        assert.match(input.Key, /^[A-Za-z0-9._ -]+$/);
        assert.ok(!input.Key.includes('..') && !input.Key.includes('/'), `unsafe key: ${input.Key}`);
        assert.strictEqual(input.ContentType, 'image/png');
        const { url } = await res.json();
        assert.ok(!url.includes('<') && !url.includes('..'), `unsafe url: ${url}`);
    } finally { await api.close(); }
});

test('sanitizeFilename neutralises hostile names', () => {
    const cases = {
        '../../etc/passwd': 'passwd',
        '..\\..\\windows\\system32\\cmd.exe': 'cmd.exe',
        'a\u0000b.pdf': 'a_b.pdf',
        'evil‮fdp.exe': 'evil_fdp.exe',                 // right-to-left override disguises the extension
        '<script>alert(1)</script>.pdf': 'script_.pdf',            // the / in </script> is a path separator
        '.htaccess': 'htaccess',
        '   ': 'document',
        '': 'document',
        'résumé final.pdf': 'r_sum_ final.pdf',
        'ＡＢＣ.pdf': 'ABC.pdf',                              // full-width letters normalise
    };
    for (const [input, expected] of Object.entries(cases)) assert.strictEqual(sanitizeFilename(input), expected, JSON.stringify(input));
    assert.strictEqual(sanitizeFilename(undefined), 'document');
    assert.strictEqual(sanitizeFilename({ toString: () => 'obj.pdf' }), 'obj.pdf');
    const long = sanitizeFilename('a'.repeat(500) + '.pdf');
    assert.ok(long.length <= 100 && long.endsWith('.pdf'), 'long names keep their extension');
});

test('MAX_FILE_SIZE_MB: valid values are used; missing, junk, zero and negative fall back to 10', () => {
    assert.strictEqual(maxMbFromEnv({ MAX_FILE_SIZE_MB: '25' }), 25);
    assert.strictEqual(maxMbFromEnv({ MAX_FILE_SIZE_MB: '0.5' }), 0.5);
    for (const bad of [undefined, '', 'abc', '0', '-5', 'Infinity']) assert.strictEqual(maxMbFromEnv({ MAX_FILE_SIZE_MB: bad }), 10, String(bad));
});

test('rejections are logged without the file contents or the raw client filename', async () => {
    const { logger, lines } = memoryLogger();
    const api = await start(fakeS3(), { logger });
    try {
        await post(api, '/api/hash', Buffer.from('SECRET-DOCUMENT-BODY'), { name: 'private-name.pdf', type: 'application/pdf' });
        const logged = lines.join('\n');
        assert.ok(!logged.includes('SECRET-DOCUMENT-BODY'));
        assert.ok(logged.includes('"status":400'));
    } finally { await api.close(); }
});
