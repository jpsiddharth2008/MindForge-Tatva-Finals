// The payload a document's QR code carries, and the strict reader for it.
//
// A QR code only says "look this document up". It is NOT proof that the paper it is printed on is genuine: a real QR can be
// photocopied onto a forgery. So verification never trusts the QR; it recomputes the content hash from the document in hand and
// requires it to equal the QR's hash (see verification.js). The payload therefore holds nothing but pointers, and no personal data.
const HEX64 = /^[a-f0-9]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const KEYS = ['v', 'contentHash', 'chainId', 'contractAddress'];
const MAX_LENGTH = 300;

/** @returns {string} compact JSON, the exact text to encode in the QR code */
function buildQrPayload({ contentHash, chainId, contractAddress }) {
    if (!HEX64.test(String(contentHash))) throw new Error('a content hash is required');
    if (!Number.isInteger(chainId) || chainId < 1) throw new Error('a chain id is required');
    if (!ADDRESS.test(String(contractAddress))) throw new Error('a contract address is required');
    return JSON.stringify({ v: 1, contentHash, chainId, contractAddress });
}

/** @returns {{ok: true, qr: {v, contentHash, chainId, contractAddress}} | {ok: false, reason: string}} */
function parseQrPayload(raw) {
    if (typeof raw !== 'string' || raw.length === 0) return { ok: false, reason: 'The QR code is empty.' };
    if (raw.length > MAX_LENGTH) return { ok: false, reason: 'The QR code is too long to be a MindForge code.' };
    let data;
    try { data = JSON.parse(raw); } catch { return { ok: false, reason: 'The QR code is not a MindForge code.' }; }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, reason: 'The QR code is not a MindForge code.' };
    const keys = Object.keys(data).sort();
    if (keys.join() !== [...KEYS].sort().join()) return { ok: false, reason: 'The QR code has unexpected content.' };   // extra keys could smuggle in data
    if (data.v !== 1) return { ok: false, reason: 'This QR code is from a version this system does not understand.' };
    if (typeof data.contentHash !== 'string' || !HEX64.test(data.contentHash)) return { ok: false, reason: 'The QR code has an invalid document fingerprint.' };
    if (!Number.isInteger(data.chainId) || data.chainId < 1) return { ok: false, reason: 'The QR code has an invalid chain.' };
    if (typeof data.contractAddress !== 'string' || !ADDRESS.test(data.contractAddress)) return { ok: false, reason: 'The QR code has an invalid contract address.' };
    return { ok: true, qr: { v: 1, contentHash: data.contentHash, chainId: data.chainId, contractAddress: data.contractAddress } };
}

/** Is the QR for the chain and contract this system is configured for? Unset settings cannot be compared and are not treated as a match. */
function pointsHere(qr, { chainId, contractAddress }) {
    if (!Number.isInteger(chainId) || !contractAddress) return false;
    return qr.chainId === chainId && qr.contractAddress.toLowerCase() === String(contractAddress).toLowerCase();
}

module.exports = { buildQrPayload, parseQrPayload, pointsHere, MAX_LENGTH };
