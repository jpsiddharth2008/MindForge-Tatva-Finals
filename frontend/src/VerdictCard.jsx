import React from 'react';

// One look per verdict, so AUTHENTIC_COPY and TAMPERED_VISUAL can never be mistaken for each other
// (and nothing is a bare green/red binary). Takes the evidence report from backend/forensics.js verify().
const STYLES = {
  AUTHENTIC_ORIGINAL: { color: '#15803d', bg: '#f0fdf4', icon: '✔', title: 'Authentic original', note: 'The file is byte-for-byte what was anchored.' },
  AUTHENTIC_COPY: { color: '#0369a1', bg: '#f0f9ff', icon: '⧉', title: 'Authentic copy', note: 'A scan, photo or forward: the content and appearance match the anchor.' },
  TAMPERED_VISUAL: { color: '#b45309', bg: '#fffbeb', icon: '◩', title: 'Appearance changed', note: 'The text matches but part of the picture does not. Check the boxed region.' },
  TAMPERED_CONTENT: { color: '#b91c1c', bg: '#fef2f2', icon: '✖', title: 'Content altered', note: 'One or more fields differ from the anchored document.' },
  INCONCLUSIVE: { color: '#6b7280', bg: '#f9fafb', icon: '?', title: 'Inconclusive', note: 'The capture could not be read reliably. Please upload a clearer image.' },
  NOT_REGISTERED: { color: '#7c3aed', bg: '#faf5ff', icon: '∅', title: 'Not registered', note: 'No anchor exists for this document.' },
  REVOKED: { color: '#9f1239', bg: '#fff1f2', icon: '⊘', title: 'Revoked', note: 'The issuer revoked this document.' },
};

const box = { border: '1px solid #e5e7eb', borderRadius: 8, padding: 12, marginTop: 12, background: '#fff' };

function RegionGrid({ regions, divergedCells }) {
  const hot = new Set((divergedCells || []).map(([r, c]) => `${r},${c}`));
  return (
    <div style={{ display: 'inline-grid', gridTemplateColumns: `repeat(${regions[0].length}, 44px)`, gap: 2 }}>
      {regions.map((row, r) => row.map((d, c) => (
        <div key={`${r},${c}`} title={`row ${r}, column ${c}: distance ${d}`}
          style={{ height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12,
            background: hot.has(`${r},${c}`) ? '#fde68a' : '#f3f4f6',
            outline: hot.has(`${r},${c}`) ? '3px solid #b45309' : 'none' }}>
          {d}
        </div>
      )))}
    </div>
  );
}

export default function VerdictCard({ report }) {
  if (!report) return null;
  const s = STYLES[report.verdict] || STYLES.INCONCLUSIVE;
  const diffs = report.tiers?.content?.fieldDiffs || [];
  const visual = report.tiers?.visual;
  return (
    <div role="status" data-verdict={report.verdict}
      style={{ border: `2px solid ${s.color}`, background: s.bg, borderRadius: 12, padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span aria-hidden style={{ fontSize: 32, color: s.color }}>{s.icon}</span>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700, color: s.color }}>{s.title}</div>
          <div style={{ fontSize: 13 }}>{s.note} Confidence: {report.confidence}.</div>
        </div>
      </div>
      {report.reason && <p style={{ fontSize: 13, marginTop: 8 }}>{report.reason}</p>}
      {diffs.length > 0 && (
        <div style={box}>
          <strong>Changed fields</strong>
          <table style={{ width: '100%', fontSize: 13, marginTop: 6 }}>
            <thead><tr><th align="left">Field</th><th align="left">Anchored</th><th align="left">Presented</th></tr></thead>
            <tbody>
              {diffs.map((d) => (
                <tr key={d.field}>
                  <td>{d.field}</td>
                  <td>{String(d.anchored ?? '(missing)')}</td>
                  <td style={{ background: '#fecaca', fontWeight: 600 }}>{String(d.presented ?? '(missing)')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {visual && visual.regions.length > 0 && (
        <div style={box}>
          <strong>Visual comparison</strong> (whole-image distance {visual.distance}; boxed cells diverge)
          <div style={{ marginTop: 6 }}><RegionGrid regions={visual.regions} divergedCells={visual.divergedCells} /></div>
        </div>
      )}
      {report.anchor && (
        <div style={{ ...box, fontSize: 12 }}>
          Anchored by {report.anchor.issuer} at {report.anchor.issuedAt}; tx {report.anchor.txHash}
        </div>
      )}
    </div>
  );
}
