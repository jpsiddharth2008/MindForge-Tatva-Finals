import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Layout from '../components/Layout';
import QrCode from '../components/QrCode';
import { anchorFile, getQrPayload, errorMessage, isUnauthorized } from '../api';
import { runAnchorFlow } from '../flows';
import { chainConfigured } from '../chain';

const ACCEPT = '.pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg';
const EMPTY = { holder: '', dob: '' };

// The officer attests to WHO the document belongs to. Everything else the hash needs - the
// issuing institution, document type, ID number and date of issue - is printed on the document
// and is read off it by the server (see tier2For in backend/app.js). Retyping printed text only
// invites typos, and a typo at issuance produces a hash the genuine document can never match.
//
// These two are still cross-checked against the print: if what the officer types confidently
// disagrees with what the document says, the issuance is refused.
const REQUIRED = [['holder', 'Holder']];
const OPTIONAL = [['dob', 'Date of birth']];

/** Only what the officer typed. Blank required fields are filled from the document by the server. */
export function buildFields(form) {
  const payload = {};
  if (form.dob.trim()) payload.dob = form.dob.trim();
  return { holder: form.holder.trim(), payload };
}

/** Issuing: enter the document's details, upload it, sign with the wallet, get the QR code. Each step says what is happening. */
export default function Issue() {
  const [form, setForm] = useState(EMPTY);
  const [file, setFile] = useState(null);
  const [step, setStep] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);   // { document, state, qr }
  const navigate = useNavigate();

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const missing = REQUIRED.filter(([k]) => !form[k].trim()).map(([, label]) => label);
  const ready = !!file && missing.length === 0 && !busy;

  const submit = async (e) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true); setError(''); setResult(null);
    try {
      setStep('Reading and storing the document…');
      const stored = await anchorFile(file, buildFields(form));
      if (stored.duplicate) {
        setError(stored.inProgress ? 'This document is already being processed. Check its status on your dashboard.' : stored.message);
        if (stored.document?.documentId) setResult({ document: stored.document, state: 'duplicate' });
        return;
      }
      const doc = { documentId: stored.document.documentId, contentHash: stored.contentHash, sha256: stored.hash };
      if (!chainConfigured()) {
        setResult({ document: stored.document, state: 'stored' });
        setError('The document was stored, but the registry contract is not configured, so it was not anchored.');
        return;
      }
      const done = await runAnchorFlow(doc, setStep);
      let qr = null;
      if (done.state === 'issued') {
        try { qr = (await getQrPayload(doc.documentId)).payload; } catch { /* the document page can show it later */ }
      }
      setResult({ document: done.document, state: done.state, qr });
    } catch (err) {
      if (err?.unauthorized || isUnauthorized(err)) return;   // the app returns to the login page
      setError(err?.name === 'FlowError' ? err.message : errorMessage(err, 'The document could not be issued.'));
    } finally {
      setBusy(false); setStep('');
    }
  };

  const input = (key, label, required, props = {}) => (
    <div key={key}>
      <label className="field-label" htmlFor={`f-${key}`}>{label}{required && <span aria-hidden> *</span>}</label>
      <input id={`f-${key}`} value={form[key]} onChange={set(key)} className="field" {...props} />
    </div>
  );

  return (
    <Layout narrow title="Issue a document">
      <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
        <p className="text-label text-ink-soft">
          Enter the holder&rsquo;s details exactly as printed. Everything else &mdash; institution, document
          type, ID number and date of issue &mdash; is read off the document itself.
        </p>
        {REQUIRED.map(([k, label]) => input(k, label, true))}
        {/* A date picker rather than free text: it yields YYYY-MM-DD, which removes the
            day-first/month-first ambiguity entirely. "01/02/2005" is two different dates
            depending on who typed it, and the wrong reading silently changes the hash.
            max=today because nobody is born in the future. */}
        {OPTIONAL.map(([k, label]) => input(k, label, false, { type: 'date', max: new Date().toISOString().slice(0, 10) }))}
        <div>
          <label className="field-label" htmlFor="f-file">The document *</label>
          <input id="f-file" type="file" accept={ACCEPT} onChange={(e) => setFile(e.target.files?.[0] || null)} className="field-file" />
        </div>
        {missing.length > 0 && (file || Object.values(form).some(Boolean)) && <p className="text-micro text-ink-faint">Still needed: {missing.join(', ')}{file ? '' : ', the document'}.</p>}
        <button type="submit" disabled={!ready} className="btn-primary btn-block py-3">
          {busy ? 'Working…' : 'Issue the document'}
        </button>
      </form>

      <div aria-live="polite" className="mt-4">
        {busy && step && <p role="status" className="text-ink-soft">{step}</p>}
        {error && <p role="alert" className="text-label font-medium text-verdict-content">{error}</p>}
        {result?.state === 'issued' && (
          <div className="mt-2 rounded border border-verdict-original/30 bg-verdict-original-bg p-4">
            <p className="mb-2 font-semibold text-verdict-original">Issued and anchored on the blockchain.</p>
            {result.qr
              ? <><p className="text-sm mb-2">Print this QR code on the document. It holds only a fingerprint, never personal details.</p><QrCode payload={result.qr} /></>
              : <p className="text-sm">The QR code could not be loaded now; it is available on the document's page.</p>}
          </div>
        )}
        {result?.state === 'pending' && <p className="text-label text-verdict-visual">The transaction is not confirmed yet. Its status will update on the document's page.</p>}
        {result?.state === 'failed' && <p className="text-label font-medium text-verdict-content">The transaction did not succeed ({result.document?.failureReason || 'unknown reason'}). Nothing was issued.</p>}
        {result?.document?.documentId && <Link to={`/officer/documents/${result.document.documentId}`} className="inline-block mt-2 font-semibold text-accent underline underline-offset-2 hover:text-accent-hover">Open this document</Link>}
        {result?.state === 'issued' && <button onClick={() => navigate('/officer')} className="ml-4 text-sm underline">Back to your documents</button>}
      </div>
    </Layout>
  );
}
