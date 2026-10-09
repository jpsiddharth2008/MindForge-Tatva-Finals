import React from 'react';
import { CHAIN_ID, explorerTxUrl } from '../config';

// One look per verdict, so AUTHENTIC_COPY and TAMPERED_VISUAL can never be mistaken for each other
// (and nothing is a bare green/red binary). Takes the answer from POST /api/verify.
export const STYLES = {
  AUTHENTIC_ORIGINAL: { color: '#15803d', bg: '#f0fdf4', icon: '✔', title: 'Authentic original', note: 'This is exactly the file that was registered.' },
  AUTHENTIC_COPY: { color: '#0369a1', bg: '#f0f9ff', icon: '⧉', title: 'Authentic copy', note: 'A scan, photo or forward: the content matches the registered document.' },
  TAMPERED_VISUAL: { color: '#b45309', bg: '#fffbeb', icon: '◩', title: 'Appearance changed', note: 'The text matches but part of the picture does not. Check the boxed region.' },
  TAMPERED_CONTENT: { color: '#b91c1c', bg: '#fef2f2', icon: '✖', title: 'Content altered', note: 'One or more fields differ from the registered document.' },
  INCONCLUSIVE: { color: '#6b7280', bg: '#f9fafb', icon: '?', title: 'Inconclusive', note: 'The document could not be checked reliably. Please provide a clearer capture.' },
  NOT_REGISTERED: { color: '#7c3aed', bg: '#faf5ff', icon: '∅', title: 'Not registered', note: 'No registered document matches this one.' },
  REVOKED: { color: '#9f1239', bg: '#fff1f2', icon: '⊘', title: 'Revoked', note: 'The issuer withdrew this document. It is no longer valid.' },
  QR_MISMATCH: { color: '#c2410c', bg: '#fff7ed', icon: '⇄', title: 'QR code does not match', note: 'The QR code does not belong to this document.' },
};

// Appearance only matters when the text matched but the bytes did not (or when it could not be read). For a byte-identical file or an
// altered field a map of zeros, or a note about the photo, is noise.
const SHOWS_APPEARANCE = new Set(['AUTHENTIC_COPY', 'TAMPERED_VISUAL', 'INCONCLUSIVE']);

const box = { border: '1px solid #e5e7eb', borderRadius: 8, padding: 12, marginTop: 12, background: '#fff' };

/** The 4x4 grid of how much each tile of the page changed, with the suspect tile boxed. */
export function Heatmap({ regions, divergedCells = [], changedRegions = [] }) {
  if (!regions || !regions.length || !regions[0]) return null;
  const hot = new Set(divergedCells.map(([r, c]) => `${r},${c}`));
  const max = Math.max(1, ...regions.flat());
  return (
    <div>
      <div role="img" aria-label="Map of how much each part of the page changed" style={{ display: 'inline-grid', gridTemplateColumns: `repeat(${regions[0].length}, 44px)`, gap: 2 }}>
        {regions.map((row, r) => row.map((d, c) => {
          const flagged = hot.has(`${r},${c}`);
          return (
            <div key={`${r},${c}`} data-cell={`${r},${c}`} data-flagged={flagged ? 'true' : 'false'} title={`row ${r + 1}, column ${c + 1}: distance ${d}`}
              style={{ height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12,
                background: flagged ? '#fde68a' : `rgba(148,163,184,${0.1 + 0.5 * (d / max)})`, outline: flagged ? '3px solid #b45309' : 'none' }}>
              {d}
            </div>
          );
        }))}
      </div>
      {changedRegions.length > 0 && <p style={{ fontSize: 12, marginTop: 4 }}>Changed: {changedRegions.join(', ')}</p>}
    </div>
  );
}

function FieldDiffs({ diffs }) {
  return (
    <div style={box}>
      <strong>Changed fields</strong>
      <table style={{ width: '100%', fontSize: 13, marginTop: 6 }}>
        <thead><tr><th align="left">Field</th><th align="left">Registered</th><th align="left">This document says</th></tr></thead>
        <tbody>
          {diffs.map((d) => (
            <tr key={d.field}>
              <td>{d.field}</td>
              <td data-testid={`anchored-${d.field}`}>{d.anchoredWithheld ? <em style={{ color: '#6b7280' }}>not shown publicly</em> : String(d.anchored ?? '(missing)')}</td>
              <td style={{ background: '#fecaca', fontWeight: 600 }}>{String(d.presented ?? '(missing)')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function VerdictCard({ report }) {
  if (!report) return null;
  const s = STYLES[report.verdict] || STYLES.INCONCLUSIVE;
  const diffs = report.tiers?.content?.fieldDiffs || [];
  const visual = report.tiers?.visual;
  const txUrl = report.anchor?.txHash ? explorerTxUrl(CHAIN_ID, report.anchor.txHash) : null;
  return (
    <div role="status" data-verdict={report.verdict} style={{ border: `2px solid ${s.color}`, background: s.bg, borderRadius: 12, padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span aria-hidden style={{ fontSize: 32, color: s.color }}>{s.icon}</span>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700, color: s.color }}>{s.title}</div>
          <div style={{ fontSize: 13 }}>{s.note} Confidence: {report.confidence}.</div>
        </div>
      </div>
      {report.reason && <p style={{ fontSize: 13, marginTop: 8 }}>{report.reason}</p>}

      {report.verdict === 'REVOKED' && report.revocation && (
        <div style={box} data-testid="revocation">
          <strong>Revoked</strong>
          {report.revocation.at && <div style={{ fontSize: 13 }}>On {new Date(report.revocation.at).toLocaleString()}</div>}
          <div style={{ fontSize: 13 }}>Reason: {report.revocation.reason || 'none given'}</div>
        </div>
      )}

      {report.qr?.checked && (
        <p style={{ fontSize: 12, marginTop: 8 }} data-testid="qr-status">
          {report.qr.matches ? 'The QR code matches this document.' : 'The QR code was checked and does not match this document.'}
        </p>
      )}
      {report.chainChecked === false && (
        <p role="note" style={{ fontSize: 12, marginTop: 8, color: '#92400e' }} data-testid="not-chain-checked">
          This answer comes from the server's own records. It was not confirmed on the blockchain.
        </p>
      )}

      {diffs.length > 0 && <FieldDiffs diffs={diffs} />}
      {visual && visual.regions?.length > 0 && SHOWS_APPEARANCE.has(report.verdict) && (
        <div style={box}>
          <strong>Appearance</strong> (how much each part of the page changed; the boxed part stands out)
          <div style={{ marginTop: 6 }}><Heatmap regions={visual.regions} divergedCells={visual.divergedCells} changedRegions={visual.changedRegions} /></div>
          {visual.unreliableRegions?.length > 0 && (
            <p data-testid="unchecked-regions" style={{ fontSize: 12, marginTop: 6, color: '#92400e' }}>
              The {visual.unreliableRegions.join(', ')} area of this document is too plain to compare reliably, so it was not checked.
            </p>
          )}
        </div>
      )}
      {report.anchor && (
        <div style={{ ...box, fontSize: 12 }} data-testid="anchor">
          Registered by <strong>{report.anchor.issuer}</strong>{report.anchor.issuedAt ? ` on ${new Date(report.anchor.issuedAt).toLocaleDateString()}` : ''}
          {txUrl && <> · <a href={txUrl} target="_blank" rel="noreferrer" style={{ color: '#2563eb' }}>view transaction</a></>}
        </div>
      )}
    </div>
  );
}
