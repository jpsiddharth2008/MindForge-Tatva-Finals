import React, { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import Layout, { StatusBadge } from '../components/Layout';
import QrCode from '../components/QrCode';
import { SHOW_QR } from '../config';
import { getDocument, getAudit, getQrPayload, errorMessage, isUnauthorized } from '../api';
import { runRevokeFlow } from '../flows';
import { explorerTxUrl } from '../config';

const when = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
const short = (h) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : '—');

function Row({ label, children }) {
  return (
    <div className="grid grid-cols-3 gap-2 py-1 border-b border-line text-sm">
      <dt className="font-semibold text-ink-soft">{label}</dt>
      <dd className="col-span-2 break-all">{children}</dd>
    </div>
  );
}

function TxLink({ chainId, hash }) {
  const url = explorerTxUrl(chainId, hash);
  if (!hash) return '—';
  return url ? <a href={url} target="_blank" rel="noreferrer" className="text-blue-700 underline">{short(hash)} (view on explorer)</a> : short(hash);
}

/** One document: its record, the transaction (with a link to the explorer), its QR code, what happened to it, and how to revoke it. */
export default function DocumentDetail() {
  const { id } = useParams();
  const [doc, setDoc] = useState(null);
  const [audit, setAudit] = useState([]);
  const [qr, setQr] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [reason, setReason] = useState('');
  const [step, setStep] = useState('');
  const [busy, setBusy] = useState(false);
  const [revokeError, setRevokeError] = useState('');
  const [note, setNote] = useState('');

  const loadAudit = useCallback(() => getAudit(id).then((r) => setAudit(r.events || [])).catch(() => setAudit([])), [id]);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const { document } = await getDocument(id);
      setDoc(document);
      loadAudit();
      if (document.status === 'ISSUED') getQrPayload(id).then((r) => setQr(r.payload)).catch(() => setQr(null)); else setQr(null);
    } catch (err) {
      if (!isUnauthorized(err)) setError(err?.response?.status === 404 ? 'This document was not found.' : errorMessage(err, 'The document could not be loaded.'));
    } finally { setLoading(false); }
  }, [id, loadAudit]);
  useEffect(() => { load(); }, [load]);

  const revoke = async (e) => {
    e.preventDefault();
    if (!reason.trim() || busy) return;
    setBusy(true); setRevokeError(''); setNote('');
    try {
      const r = await runRevokeFlow(doc, reason, setStep);
      if (r.state === 'revoked') { setNote('The document is revoked. Anyone verifying it will now see that.'); setReason(''); setQr(null); }
      else if (r.state === 'pending') setNote('The transaction is not confirmed yet. Check again shortly.');
      else setRevokeError('The revocation did not go through on the blockchain.');
      setDoc(r.document);
      loadAudit();
    } catch (err) {
      if (!err?.unauthorized) setRevokeError(err.message);
    } finally { setBusy(false); setStep(''); }
  };

  return (
    <Layout title="Document">
      <Link to="/officer" className="text-sm text-blue-700 underline">← Your documents</Link>
      {loading && <p role="status" className="mt-3">Loading…</p>}
      {error && <p role="alert" className="mt-3 text-red-700">{error}</p>}
      {doc && (
        <>
          <div className="flex items-center gap-3 my-3"><h2 className="text-xl font-bold break-all">{doc.originalFileName || doc.documentId}</h2><StatusBadge status={doc.status} /></div>
          <dl>
            <Row label="Document id">{doc.documentId}</Row>
            <Row label="File fingerprint (SHA-256)">{doc.sha256}</Row>
            <Row label="Content fingerprint">{doc.contentHash || 'None (stored without details)'}</Row>
            <Row label="Details check">{doc.ocrCheck || '—'}</Row>
            <Row label="Created">{when(doc.createdAt)}</Row>
            {doc.status !== 'STORED' && <Row label="Transaction"><TxLink chainId={doc.chainId} hash={doc.transactionHash} /></Row>}
            {doc.blockNumber != null && <Row label="Block">{doc.blockNumber}</Row>}
            {doc.issuedAt && <Row label="Issued">{when(doc.issuedAt)}</Row>}
            {doc.status === 'FAILED' && <Row label="Why it failed">{doc.failureReason || 'unknown'}</Row>}
            {doc.status === 'REVOKED' && (
              <>
                <Row label="Revoked">{when(doc.revokedAt)}</Row>
                <Row label="Reason">{doc.revocationReason || '—'}</Row>
                {doc.revocationTxHash && <Row label="Revocation transaction"><TxLink chainId={doc.chainId} hash={doc.revocationTxHash} /></Row>}
              </>
            )}
          </dl>

          {SHOW_QR && qr && <section className="mt-4"><h3 className="font-bold mb-2">QR code</h3><QrCode payload={qr} filename={`${doc.documentId}-qr.png`} /></section>}

          {doc.status === 'ISSUED' && (
            <form onSubmit={revoke} className="mt-6 border border-rose-200 rounded-lg p-4">
              <h3 className="font-bold text-rose-900 mb-1">Revoke this document</h3>
              <p className="text-label text-ink-soft mb-2">This is public and cannot be undone. The reason is stored on the blockchain and shown to anyone who verifies the document.</p>
              <label className="field-label" htmlFor="reason">Reason</label>
              <input id="reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} className="w-full border border-line-strong rounded-lg px-3 py-2 mb-2" />
              <button type="submit" disabled={!reason.trim() || busy} className="bg-rose-700 text-white px-4 py-2 rounded-lg font-semibold hover:bg-rose-800 disabled:opacity-50">{busy ? 'Working…' : 'Revoke'}</button>
              <div aria-live="polite">
                {busy && step && <p role="status" className="text-sm mt-2">{step}</p>}
                {revokeError && <p role="alert" className="text-red-700 text-sm mt-2">{revokeError}</p>}
              </div>
            </form>
          )}
          {note && <p role="status" className="mt-3 text-label text-ink-soft">{note}</p>}

          <section className="mt-6">
            <h3 className="font-bold mb-2">History</h3>
            {audit.length === 0 ? <p className="text-label text-ink-soft">No events recorded.</p> : (
              <table className="w-full text-sm text-left">
                <thead><tr className="border-b border-line text-ink-soft"><th className="py-1">When</th><th>Action</th><th>Outcome</th><th>Detail</th></tr></thead>
                <tbody>
                  {audit.map((e, i) => (
                    <tr key={`${e.createdAt}-${i}`} className="border-b border-line">
                      <td className="py-1 whitespace-nowrap">{when(e.createdAt)}</td><td>{e.action}</td><td>{e.outcome}</td><td>{e.reason || ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </Layout>
  );
}
