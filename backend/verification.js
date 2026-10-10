// Public verification: "is this document the one an authorised issuer registered, and has it been altered?"
//
// It brings the pieces together without letting any one of them overrule the others:
//   * the CHAIN decides whether a document is registered and whether it is revoked (the database only mirrors it);
//   * Tier 1 (the exact file) and Tier 2 (what the document says) decide authenticity;
//   * Tier 3 (how it looks) can only agree with Tier 2 or ask a human to look: it is never what makes a document authentic;
//   * a QR code is never trusted: the content hash is recomputed from the document in hand and must equal the QR's.
// A document that is not registered is NOT_REGISTERED, however much it resembles one that is.
const crypto = require('crypto');
const forensics = require('./forensics');
const { compareToAnchor } = require('./tier2');
const { compareVisual, advice } = require('./phash');
const { flatRecord, contentHash: recomputeContentHash } = require('./content-hash');
const { parseQrPayload, pointsHere } = require('./qr');

const ANCHORED = ['ISSUED', 'REVOKED'];          // the statuses of a document that really is on the registry
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * Does the stored canonical record still hash to the content hash that is on the chain?
 *
 * The VERDICT never depends on this: it is decided by comparing hashes the registry confirms.
 * But the FIELD-LEVEL DIFF does - "anchored 2005-04-12, presented 2003-04-12" is read straight
 * out of the database. Nothing else re-derives it, so anyone able to edit the database could
 * change what a verifier is told the true value was, while the verdict stayed correct.
 *
 * Recomputing closes that: the content hash is already on chain, so the stored record can be
 * checked against it without touching the contract.
 *
 * A false result is not proof of tampering - bumping content-hash.js's VERSION_TAG would also
 * invalidate every record written under the old rules. Either way the stored values are no
 * longer known to be what was anchored, so they must not be shown as if they were.
 */
function anchoredRecordIsTrustworthy(record) {
    if (!record || !record.canonicalRecord || !record.contentHash) return false;
    try {
        return recomputeContentHash(record.canonicalRecord).hash === record.contentHash;
    } catch {
        return false;      // a record that cannot even be canonicalised cannot be vouched for
    }
}

/** An error whose message is safe to show the client. */
class VerificationError extends Error {
    constructor(status, publicMessage) {
        super(publicMessage);
        this.name = 'VerificationError';
        this.status = status;
        this.publicMessage = publicMessage;
    }
}

/**
 * @param {object} o
 * @param {object} o.documents  repository (documents.js)
 * @param {object} [o.chain]    chain layer (chain.js). Without it the database's own record is used and the answer says chainChecked: false
 * @param {function} o.analyse  Tier 2: image bytes -> analysis (tier2.analyseImage)
 * @param {function} o.visualise Tier 3: image bytes -> look-hash (phash.analyseVisual)
 */
function createVerification({ documents, chain = null, analyse, visualise, chainId, contractAddress, thresholds, logger = console }) {
    // What the registry says about a content hash. The chain, when we have it, is the authority; the database is the fallback.
    async function registryState(record) {
        if (!record) return null;
        if (chain && record.contentHash) {
            const onChain = await chain.verify(record.contentHash);
            return { chainChecked: true, registered: onChain.exists, revoked: onChain.revoked, issuerName: onChain.issuerName || record.issuerName, issuedAt: onChain.issuedAt };
        }
        return { chainChecked: false, registered: ANCHORED.includes(record.status), revoked: record.status === 'REVOKED', issuerName: record.issuerName, issuedAt: record.issuedAt ? Math.floor(new Date(record.issuedAt).getTime() / 1000) : null };
    }

    async function lookUp(sha, analysis) {
        const anchored = (r) => r && ANCHORED.includes(r.status) ? r : null;
        const byFile = anchored(await documents.findBySha256(sha));
        if (byFile) return { record: byFile, how: 'file' };
        if (analysis && analysis.status === 'READ') {
            const byContent = anchored(await documents.findByContentHash(analysis.contentHash));
            if (byContent) return { record: byContent, how: 'content' };
            // not the same document, but is it a doctored copy of one? Find the document with the same issuer, type and ID
            const candidates = (await documents.findByLookupKey(analysis.lookupKey)).filter((r) => ANCHORED.includes(r.status));
            if (candidates.length) return { record: candidates[0], how: 'identity' };      // newest first
        }
        return { record: null, how: null };
    }

    async function revocationOf(record) {
        const mirrored = { reason: record.revocationReason || null, at: record.revokedAt ? new Date(record.revokedAt).toISOString() : null };
        if (chain && record.contentHash) {
            try {
                const r = await chain.getRevocation(record.contentHash);
                if (r) return { reason: r.reason, at: r.at.toISOString() };           // what the chain says wins over the mirror
            } catch { /* the mirror is still a correct answer */ }
        }
        return mirrored;
    }

    /**
     * @param {{buffer: Buffer, mime: string, qrRaw?: string, issuerView?: boolean}} input
     * @returns {Promise<object>} { verdict, confidence, reason, tiers, anchor, revocation?, qr?, chainChecked }
     */
    async function verifyDocument({ buffer, mime, qrRaw, issuerView = false }) {
        const sha = sha256(buffer);
        const isImage = mime !== 'application/pdf';

        // a malformed QR is the caller's mistake: say so before spending any effort
        let qr = null;
        if (qrRaw !== undefined && qrRaw !== null && qrRaw !== '') {
            const parsed = parseQrPayload(qrRaw);
            if (!parsed.ok) throw new VerificationError(422, parsed.reason);
            qr = parsed.qr;
        }

        const analysis = isImage ? await analyse(buffer) : null;
        const { record, how } = await lookUp(sha, analysis);
        const state = await registryState(record);
        const byteMatch = !!record && record.sha256 === sha;

        // ---- the QR code: never trusted, only compared ----
        let qrInfo = null;
        if (qr) {
            const here = pointsHere(qr, { chainId, contractAddress });
            // what the document in hand says its content hash is: read from the picture, or known because it is the exact registered file
            const presented = analysis && analysis.status === 'READ' ? analysis.contentHash : (byteMatch ? record.contentHash : null);
            qrInfo = { checked: true, pointsHere: here, matches: here && presented === qr.contentHash };
            if (!presented) {
                return finish(qrInfo, issuerView, {
                    verdict: 'INCONCLUSIVE', confidence: 'LOW', tiers: { byte: { match: false } }, anchor: null,
                    reason: 'The document could not be read, so the QR code cannot be checked against it. A QR code on its own proves nothing.',
                }, state, record);
            }
            if (!here || presented !== qr.contentHash) {
                return finish(qrInfo, issuerView, {
                    verdict: 'QR_MISMATCH', confidence: 'HIGH', tiers: { byte: { match: byteMatch } }, anchor: null,
                    reason: !here ? 'The QR code is for a different chain or registry.' : 'The QR code does not match this document.',
                }, state, record);
            }
        }

        // ---- build what the engine needs ----
        let content = null;
        let visual = null;
        if (record && record.canonicalRecord && analysis) {
            const cmp = compareToAnchor(record.canonicalRecord, record.contentHash, analysis);
            let ocrConfidence = 0;                                    // unreadable or doubtful: the engine reports INCONCLUSIVE
            if (cmp.status === 'MATCH') ocrConfidence = 1;            // equal hashes prove the read right, whatever its confidence
            else if (cmp.status === 'MISMATCH') {
                // a field the anchor has and the document lacks was missed with certainty (that is how a MISMATCH is declared); the others use their reading confidence
                ocrConfidence = Math.min(...cmp.fieldDiffs.map((d) => (typeof analysis.confidences[d.field] === 'number' ? analysis.confidences[d.field] : (d.presented === null ? 100 : 0)))) / 100;
            }
            // The verdict below is decided by hashes the chain confirms, so it stands either way.
            // The stored field VALUES are only shown when they still hash to what was anchored.
            const trustworthy = anchoredRecordIsTrustworthy(record);
            if (!trustworthy) {
                logger.warn?.('stored canonical record does not match the anchored content hash', { documentId: record.documentId });
            }
            content = {
                anchored: trustworthy ? flatRecord(record.canonicalRecord) : {},
                presented: analysis.status === 'READ' ? flatRecord(analysis.record) : {},
                ocrConfidence,
                anchoredRecordVerified: trustworthy,
            };
            if (analysis.status !== 'READ') content.presented = trustworthy ? flatRecord(record.canonicalRecord) : {};   // nothing was read: do not invent differences
        }
        if (record && record.visual && isImage) {
            try {
                const look = await visualise(buffer);
                const cmp = compareVisual(record.visual, look, thresholds);
                visual = { advice: advice(cmp), distance: cmp.distance, cellDistances: cmp.cells, divergedCells: cmp.diverged, changedRegions: cmp.changedRegions, unreliableRegions: cmp.unreliableRegions };
            } catch { visual = null; }                                // appearance is advisory: failing to read it must not break verification
        }

        // A picture too poor to read, that is not the exact registered file, is "could not read it": never a verdict. (Without a reading
        // there is nothing to look up, so "not registered" would be a false accusation of a genuine document.)
        if (isImage && analysis.status !== 'READ' && !byteMatch) {
            return finish(qrInfo, issuerView, {
                verdict: 'INCONCLUSIVE', confidence: 'LOW', tiers: { byte: { match: false } }, anchor: null,
                reason: 'The document could not be read reliably. Request a clearer, flatter, better-lit capture.',
            }, state, record);
        }

        const report = forensics.verify({
            registered: !!(state && state.registered),
            revoked: !!(state && state.revoked),
            anchor: record && state ? {
                issuer: state.issuerName, issuedAt: state.issuedAt ? new Date(state.issuedAt * 1000).toISOString() : null,
                txHash: record.transactionHash || null, blockNumber: record.blockNumber || null,
            } : null,
            byte: { match: byteMatch },
            content, visual,
        });
        if (report.verdict === 'REVOKED' && record) report.revocation = await revocationOf(record);
        if (report.verdict === 'NOT_REGISTERED' && !isImage) {
            report.reason = 'This exact file is not registered. A PDF can only be matched byte for byte: a re-saved copy of a registered PDF cannot be recognised by its content. Ask for the original file, or a photograph of the document.';
        }
        return finish(qrInfo, issuerView, report, state, record);
    }

    // shape and privacy of the answer
    function finish(qrInfo, issuerView, report, state, record) {
        const out = { ...report, chainChecked: state ? state.chainChecked : (chain !== null) };
        if (record) out.documentId = record.documentId;        // for the audit trail; the route removes it before replying
        if (qrInfo) out.qr = qrInfo;
        // The anchored side of a field difference is the document's TRUE value. The public does not need it to be told WHICH field
        // changed, and handing it out would let anyone who knows an ID number learn a holder's real details. Issuers see everything.
        if (!issuerView && out.tiers && out.tiers.content && out.tiers.content.fieldDiffs) {
            out.tiers = { ...out.tiers, content: { ...out.tiers.content, fieldDiffs: out.tiers.content.fieldDiffs.map((d) => ({ field: d.field, anchored: null, presented: d.presented, anchoredWithheld: true })) } };
        }
        return out;
    }

    return { verifyDocument };
}

module.exports = { createVerification, VerificationError, ANCHORED };
