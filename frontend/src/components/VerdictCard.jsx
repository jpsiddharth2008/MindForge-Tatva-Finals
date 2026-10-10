import React from 'react';
import { CHAIN_ID, explorerTxUrl } from '../config';

// One look per verdict, so AUTHENTIC_COPY and TAMPERED_VISUAL can never be mistaken for each other
// (and nothing is a bare green/red binary). Takes the answer from POST /api/verify.
//
// The wording carries as much weight as the verdict. Two traps it is written around:
//
//   1. AUTHENTIC_COPY must not read as second-class. It is the NORMAL result for any real
//      document, because anything printed, scanned or forwarded has different bytes. A verifier
//      who reads "copy" as "not the real thing" has been misled by us, not by the document.
//   2. NOT_REGISTERED must not read as "forgery". It means no match was found, which also
//      happens to a genuine document that was never issued through this system.
//
// `tone` and `wash` are token class names, not hex. Every verdict colour is declared once in
// tailwind.config.js, so the card, the status badge and any future surface cannot drift apart.
export const STYLES = {
  AUTHENTIC_ORIGINAL: { tone: 'text-verdict-original', wash: 'bg-verdict-original-bg border-verdict-original', icon: '✔', title: 'Authentic original', note: 'Genuine, and byte-for-byte the exact file the issuer registered.' },
  AUTHENTIC_COPY: { tone: 'text-verdict-copy', wash: 'bg-verdict-copy-bg border-verdict-copy', icon: '⧉', title: 'Authentic copy', note: 'Genuine. The file itself differs because the document was photographed, scanned or forwarded, but every printed detail matches what the issuer registered. This is the normal result for a document that has left the digital channel.' },
  TAMPERED_VISUAL: { tone: 'text-verdict-visual', wash: 'bg-verdict-visual-bg border-verdict-visual', icon: '◩', title: 'Appearance changed', note: 'Every printed detail matches, but part of the image does not — most often a replaced photograph. The boxed region is where it differs. Appearance is advisory: confirm with the issuer before acting on it.' },
  TAMPERED_CONTENT: { tone: 'text-verdict-content', wash: 'bg-verdict-content-bg border-verdict-content', icon: '✖', title: 'Content altered', note: 'A printed detail does not match what the issuer registered. The fields that differ are listed below.' },
  INCONCLUSIVE: { tone: 'text-verdict-unknown', wash: 'bg-verdict-unknown-bg border-verdict-unknown', icon: '?', title: 'Inconclusive', note: 'Not enough could be read to judge this document. That is deliberately not a verdict — a poor photograph must never be mistaken for a forgery. Try again, flatter and in better light.' },
  NOT_REGISTERED: { tone: 'text-verdict-absent', wash: 'bg-verdict-absent-bg border-verdict-absent', icon: '∅', title: 'Not registered', note: 'No registered document matches this one. Either it was never issued through this registry, or it has been altered past recognition. This is not by itself proof of forgery.' },
  REVOKED: { tone: 'text-verdict-revoked', wash: 'bg-verdict-revoked-bg border-verdict-revoked', icon: '⊘', title: 'Revoked', note: 'The issuer withdrew this document. It is no longer valid, even though it is otherwise genuine and unaltered.' },
  QR_MISMATCH: { tone: 'text-verdict-qr', wash: 'bg-verdict-qr-bg border-verdict-qr', icon: '⇄', title: 'QR code does not match', note: 'The QR code points at a different document. A genuine code photocopies onto a forgery perfectly well, so the code alone proves nothing — the document itself is what was checked.' },
};

// Appearance only matters when the text matched but the bytes did not (or when it could not be read). For a byte-identical file or an
// altered field a map of zeros, or a note about the photo, is noise.
const SHOWS_APPEARANCE = new Set(['AUTHENTIC_COPY', 'TAMPERED_VISUAL', 'INCONCLUSIVE']);

/** A titled sub-panel inside the verdict card. */
function Panel({ title, children, ...rest }) {
  return (
    <section className="mt-3 rounded border border-line bg-paper p-3" {...rest}>
      {title && <h3 className="text-label font-semibold text-ink">{title}</h3>}
      {children}
    </section>
  );
}

/** The 4x4 grid of how much each tile of the page changed, with the suspect tile boxed. */
export function Heatmap({ regions, divergedCells = [], changedRegions = [] }) {
  if (!regions || !regions.length || !regions[0]) return null;
  const hot = new Set(divergedCells.map(([r, c]) => `${r},${c}`));
  const max = Math.max(1, ...regions.flat());
  return (
    <div>
      <div
        role="img"
        aria-label="Map of how much each part of the page changed"
        className="inline-grid gap-0.5"
        style={{ gridTemplateColumns: `repeat(${regions[0].length}, 2.5rem)` }}
      >
        {regions.map((row, r) => row.map((d, c) => {
          const flagged = hot.has(`${r},${c}`);
          return (
            <div
              key={`${r},${c}`}
              data-cell={`${r},${c}`}
              data-flagged={flagged ? 'true' : 'false'}
              title={`row ${r + 1}, column ${c + 1}: distance ${d}`}
              // The flagged tile is ringed as well as filled: on a greyscale
              // projector, or to a colourblind viewer, the fill alone would not
              // single it out - and singling it out is the whole point.
              className={`tabular flex h-8 items-center justify-center text-micro ${
                flagged ? 'bg-verdict-visual-bg font-bold text-verdict-visual ring-2 ring-inset ring-verdict-visual' : 'text-ink-soft'
              }`}
              style={flagged ? undefined : { background: `rgba(148,163,184,${0.08 + 0.45 * (d / max)})` }}
            >
              {d}
            </div>
          );
        }))}
      </div>
      {changedRegions.length > 0 && <p className="mt-1.5 text-micro text-ink-soft">Changed: {changedRegions.join(', ')}</p>}
    </div>
  );
}

function FieldDiffs({ diffs }) {
  return (
    <Panel title="Changed fields">
      <table className="mt-2 w-full border-collapse text-label">
        <thead>
          <tr className="border-b border-line text-left text-micro uppercase tracking-wide text-ink-faint">
            <th scope="col" className="pb-1.5 font-semibold">Field</th>
            <th scope="col" className="pb-1.5 font-semibold">Registered</th>
            <th scope="col" className="pb-1.5 font-semibold">This document says</th>
          </tr>
        </thead>
        <tbody>
          {diffs.map((d) => (
            <tr key={d.field} className="border-b border-line last:border-0 align-top">
              <td className="py-1.5 pr-3 font-medium text-ink">{d.field}</td>
              <td className="py-1.5 pr-3 text-ink-soft" data-testid={`anchored-${d.field}`}>
                {d.anchoredWithheld ? <em className="text-ink-faint">not shown publicly</em> : String(d.anchored ?? '(missing)')}
              </td>
              <td className="py-1.5">
                <span className="rounded-xs bg-verdict-content-bg px-1.5 py-0.5 font-semibold text-verdict-content">
                  {String(d.presented ?? '(missing)')}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

export default function VerdictCard({ report }) {
  if (!report) return null;
  const s = STYLES[report.verdict] || STYLES.INCONCLUSIVE;
  const diffs = report.tiers?.content?.fieldDiffs || [];
  const visual = report.tiers?.visual;
  const txUrl = report.anchor?.txHash ? explorerTxUrl(CHAIN_ID, report.anchor.txHash) : null;

  return (
    <div role="status" data-verdict={report.verdict} className={`rounded-lg border-l-4 border border-line p-4 ${s.wash}`}>
      <div className="flex items-start gap-3">
        <span aria-hidden className={`text-2xl leading-none ${s.tone}`}>{s.icon}</span>
        <div className="min-w-0">
          <h2 className={`text-base font-bold tracking-tight ${s.tone}`}>{s.title}</h2>
          <p className="mt-1 max-w-reading text-label leading-relaxed text-ink-soft">{s.note}</p>
          <p className="mt-1.5 text-micro font-medium uppercase tracking-wide text-ink-faint">
            Confidence: {report.confidence}
          </p>
        </div>
      </div>

      {report.reason && <p className="mt-3 max-w-reading text-label text-ink-soft">{report.reason}</p>}

      {report.verdict === 'REVOKED' && report.revocation && (
        <Panel title="Revoked" data-testid="revocation">
          {report.revocation.at && <p className="mt-1 text-label text-ink-soft">On {new Date(report.revocation.at).toLocaleString()}</p>}
          <p className="text-label text-ink-soft">Reason: {report.revocation.reason || 'none given'}</p>
        </Panel>
      )}

      {report.qr?.checked && (
        <p className="mt-3 text-label text-ink-soft" data-testid="qr-status">
          {report.qr.matches ? 'The QR code matches this document.' : 'The QR code was checked and does not match this document.'}
        </p>
      )}

      {report.chainChecked === false && (
        <p role="note" data-testid="not-chain-checked" className="mt-3 rounded border border-verdict-visual/30 bg-verdict-visual-bg px-3 py-2 text-label text-verdict-visual">
          This answer comes from the server&rsquo;s own records. It was not confirmed on the blockchain.
        </p>
      )}

      {diffs.length > 0 && <FieldDiffs diffs={diffs} />}

      {visual && visual.regions?.length > 0 && SHOWS_APPEARANCE.has(report.verdict) && (
        <Panel title="Appearance">
          <p className="mb-2 text-micro text-ink-faint">How much each part of the page changed; the boxed part stands out.</p>
          <Heatmap regions={visual.regions} divergedCells={visual.divergedCells} changedRegions={visual.changedRegions} />
          {visual.unreliableRegions?.length > 0 && (
            <p data-testid="unchecked-regions" className="mt-2 text-micro text-verdict-visual">
              The {visual.unreliableRegions.join(', ')} area of this document is too plain to compare reliably, so it was not checked.
            </p>
          )}
        </Panel>
      )}

      {report.anchor && (
        <Panel data-testid="anchor">
          <p className="text-label text-ink-soft">
            Registered by <strong className="font-semibold text-ink">{report.anchor.issuer}</strong>
            {report.anchor.issuedAt ? ` on ${new Date(report.anchor.issuedAt).toLocaleDateString()}` : ''}
            {txUrl && (
              <>
                {' · '}
                <a href={txUrl} target="_blank" rel="noreferrer" className="font-medium text-accent underline underline-offset-2 hover:text-accent-hover">
                  view transaction
                </a>
              </>
            )}
          </p>
        </Panel>
      )}
    </div>
  );
}
