// The contract's ABI exists in three places (the Hardhat package, the backend, the frontend) so each can be deployed alone.
// If they ever differ, the app talks to a contract that is not the one that was tested.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const copies = {
    hardhat: path.join(root, 'blockchain', 'abi', 'CredentialRegistry.json'),
    backend: path.join(root, 'backend', 'abi', 'CredentialRegistry.json'),
    frontend: path.join(root, 'frontend', 'src', 'abi', 'CredentialRegistry.json'),
};

test('the backend and frontend ABI copies are identical to the one the contract tests use', () => {
    const present = Object.entries(copies).filter(([, f]) => fs.existsSync(f));
    assert.ok(present.length >= 1, 'at least the backend copy must exist');
    const reference = JSON.stringify(JSON.parse(fs.readFileSync(copies.backend, 'utf8')));
    for (const [name, file] of present) assert.strictEqual(JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8'))), reference, `${name} ABI differs from the backend's`);
});

test('the ABI has the functions and events the app depends on', () => {
    const abi = JSON.parse(fs.readFileSync(copies.backend, 'utf8'));
    const sig = (e) => `${e.name}(${e.inputs.map((i) => i.type).join(',')})`;
    const fns = abi.filter((e) => e.type === 'function').map(sig);
    for (const needed of ['anchor(bytes32,bytes32)', 'revoke(bytes32,string)', 'verify(bytes32)', 'verifyByByteHash(bytes32)', 'isIssuer(address)']) assert.ok(fns.includes(needed), needed);
    assert.ok(abi.some((e) => e.type === 'event' && e.name === 'Revoked'));
    assert.ok(!fns.includes('addDocument(string)'), 'the old, ungated function must not be in the ABI');
});
