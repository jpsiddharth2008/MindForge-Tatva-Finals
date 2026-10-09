// Tamper forensics engine: reasons over the disagreement between the three hash tiers.
// Pure functions only (no I/O), so every verdict is unit-testable. See forensics.test.js.
//
// Input to verify():
//   registered : boolean              the anchor was found on chain
//   revoked    : boolean              the anchor was revoked
//   anchor     : { issuer, issuedAt, txHash } | null
//   byte       : { match: boolean }   Tier 1, SHA-256 of the file bytes
//   content    : { anchored, presented, ocrConfidence }   Tier 2, canonical fields (objects) + 0..1 confidence
//   visual     : { distance, cellDistances } | null       Tier 3, pHash Hamming distance + per-cell grid
//
// Thresholds are tunable defaults, not measured values. Calibrate them against real Tier 3 output.

const THRESHOLDS = {
  minOcrConfidence: 0.8,   // below this, the content tier cannot be trusted -> INCONCLUSIVE
  highOcrConfidence: 0.9,  // at or above this, a content mismatch is reported with HIGH confidence
  visualFar: 10,           // whole-image pHash distance (of 64 bits) above this counts as "far"
  cellFar: 10,             // per-cell distance above this is a diverged region
};

const VERDICTS = [
  'AUTHENTIC_ORIGINAL', 'AUTHENTIC_COPY', 'TAMPERED_VISUAL', 'TAMPERED_CONTENT',
  'INCONCLUSIVE', 'NOT_REGISTERED', 'REVOKED',
];

// Number of differing bits between two equal-length hex strings.
function hammingHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) {
    throw new Error('hammingHex needs two hex strings of equal length');
  }
  if (!/^[0-9a-f]*$/i.test(a) || !/^[0-9a-f]*$/i.test(b)) throw new Error('hammingHex got a non-hex character');
  let bits = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { bits += x & 1; x >>= 1; }
  }
  return bits;
}

// Per-cell Hamming distances between two equal-shaped grids of hex hashes.
function compareGrids(anchored, presented) {
  if (anchored.length !== presented.length) throw new Error('grid row counts differ');
  return anchored.map((row, r) => {
    if (row.length !== presented[r].length) throw new Error('grid column counts differ');
    return row.map((cell, c) => hammingHex(cell, presented[r][c]));
  });
}

// Every field that differs. A field missing on one side shows as null on that side.
function fieldDiffs(anchored = {}, presented = {}) {
  const names = [...new Set([...Object.keys(anchored), ...Object.keys(presented)])].sort();
  return names
    .filter((f) => (anchored[f] ?? null) !== (presented[f] ?? null))
    .map((f) => ({ field: f, anchored: anchored[f] ?? null, presented: presented[f] ?? null }));
}

// [row, col] of every cell whose distance exceeds the threshold.
function divergedCells(cellDistances, cellFar = THRESHOLDS.cellFar) {
  const out = [];
  (cellDistances || []).forEach((row, r) => row.forEach((d, c) => { if (d > cellFar) out.push([r, c]); }));
  return out;
}

function report(verdict, confidence, tiers, anchor, reason) {
  return { verdict, confidence, reason, tiers, anchor: anchor || null };
}

function verify(input, t = THRESHOLDS) {
  const { registered, revoked, anchor, byte, content, visual } = input;
  const tiers = { byte: { match: !!(byte && byte.match) } };

  // Not anchored: nothing to compare against. Visual similarity must never rescue this.
  if (!registered) {
    return report('NOT_REGISTERED', 'HIGH', tiers, null, 'No anchor exists for this document.');
  }
  if (content) {
    const diffs = fieldDiffs(content.anchored, content.presented);
    tiers.content = { match: diffs.length === 0, fieldDiffs: diffs, ocrConfidence: content.ocrConfidence ?? null };
  }
  if (visual) {
    tiers.visual = { distance: visual.distance, regions: visual.cellDistances || [],
                     divergedCells: divergedCells(visual.cellDistances, t.cellFar) };
  }
  if (revoked) {
    return report('REVOKED', 'HIGH', tiers, anchor, 'The anchor was revoked by the issuer.');
  }
  // Identical bytes cannot differ in content or appearance.
  if (tiers.byte.match) {
    return report('AUTHENTIC_ORIGINAL', 'HIGH', tiers, anchor, 'File bytes match the anchor.');
  }
  if (!content || !(content.ocrConfidence >= t.minOcrConfidence)) {
    return report('INCONCLUSIVE', 'LOW', tiers, anchor, 'Content could not be read reliably. Request a better capture.');
  }
  if (!tiers.content.match) {
    const conf = content.ocrConfidence >= t.highOcrConfidence ? 'HIGH' : 'MEDIUM';
    const names = tiers.content.fieldDiffs.map((d) => d.field).join(', ');
    return report('TAMPERED_CONTENT', conf, tiers, anchor, `Fields differ from the anchor: ${names}.`);
  }
  // Content matches, bytes do not: only the visual tier can tell a copy from a substitution.
  if (!visual) {
    return report('INCONCLUSIVE', 'LOW', tiers, anchor, 'Content matches but no visual evidence was available.');
  }
  if (visual.distance > t.visualFar || tiers.visual.divergedCells.length > 0) {
    return report('TAMPERED_VISUAL', 'MEDIUM', tiers, anchor,
      'Text matches but the appearance changed (possible photo or graphic substitution).');
  }
  const conf = visual.distance <= t.visualFar / 2 ? 'HIGH' : 'MEDIUM';
  return report('AUTHENTIC_COPY', conf, tiers, anchor, 'Content and appearance match; the file is a re-capture or copy.');
}

module.exports = { THRESHOLDS, VERDICTS, hammingHex, compareGrids, fieldDiffs, divergedCells, verify };
