import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Layout from '../components/Layout';
import QrCode from '../components/QrCode';
import { anchorFile, getQrPayload, errorMessage, isUnauthorized } from '../api';
import { runAnchorFlow } from '../flows';
import { chainConfigured } from '../chain';

const ACCEPT = '.pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg';
const EMPTY = { issuer: '', docType: '', holder: '', idNumber: '', issuedOn: '', dob: '', programme: '', cgpa: '' };
const REQUIRED = [['issuer', 'Issuing institution'], ['docType', 'Document type'], ['holder', 'Holder'], ['idNumber', 'ID number'], ['issuedOn', 'Issued on']];
const OPTIONAL = [['dob', 'Date of birth'], ['programme', 'Programme'], ['cgpa', 'CGPA']];

/** What the server needs: the five required details, and anything else printed on the document under `payload`. */
export function buildFields(form) {
  const payload = {};
  for (const [key] of OPTIONAL) if (form[key].trim()) payload[key] = form[key].trim();
  return { issuer: form.issuer, docType: form.docType, holder: form.holder, idNumber: form.idNumber, issuedOn: form.issuedOn, payload };
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
      <label className="block text-sm font-semibold mb-1" htmlFor={`f-${key}`}>{label}{required && <span aria-hidden> *</span>}</label>
      <input id={`f-${key}`} value={form[key]} onChange={set(key)} className="w-full border border-slate-300 rounded-lg px-3 py-2" {...props} />
    </div>
  );

  return (
    <Layout narrow title="Issue a document">
      <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
        <p className="text-sm text-slate-600">Enter the details exactly as printed on the document. They are read back from the document and must agree with it.</p>
        {REQUIRED.map(([k, label]) => input(k, label, true, k === 'issuedOn' ? { placeholder: 'e.g. 15 Jun 2026' } : {}))}
        {OPTIONAL.map(([k, label]) => input(k, label, false))}
        <div>
          <label className="block text-sm font-semibold mb-1" htmlFor="f-file">The document *</label>
          <input id="f-file" type="file" accept={ACCEPT} onChange={(e) => setFile(e.target.files?.[0] || null)} className="block w-full text-sm text-slate-500 border border-dashed border-slate-300 rounded-lg p-3" />
        </div>
        {missing.length > 0 && (file || Object.values(form).some(Boolean)) && <p className="text-xs text-slate-500">Still needed: {missing.join(', ')}{file ? '' : ', the document'}.</p>}
        <button type="submit" disabled={!ready} className="bg-[#111827] text-white py-3 rounded-lg font-bold hover:bg-black disabled:opacity-50">
          {busy ? 'Working…' : 'Issue the document'}
        </button>
      </form>

      <div aria-live="polite" className="mt-4">
        {busy && step && <p role="status" className="text-slate-700">{step}</p>}
        {error && <p role="alert" className="text-red-700 text-sm">{error}</p>}
        {result?.state === 'issued' && (
          <div className="border border-green-300 bg-green-50 rounded-lg p-4 mt-2">
            <p className="font-bold text-green-900 mb-2">Issued and anchored on the blockchain.</p>
            {result.qr
              ? <><p className="text-sm mb-2">Print this QR code on the document. It holds only a fingerprint, never personal details.</p><QrCode payload={result.qr} /></>
              : <p className="text-sm">The QR code could not be loaded now; it is available on the document's page.</p>}
          </div>
        )}
        {result?.state === 'pending' && <p className="text-amber-800 text-sm">The transaction is not confirmed yet. Its status will update on the document's page.</p>}
        {result?.state === 'failed' && <p className="text-red-700 text-sm">The transaction did not succeed ({result.document?.failureReason || 'unknown reason'}). Nothing was issued.</p>}
        {result?.document?.documentId && <Link to={`/officer/documents/${result.document.documentId}`} className="inline-block mt-2 text-blue-700 font-semibold underline">Open this document</Link>}
        {result?.state === 'issued' && <button onClick={() => navigate('/officer')} className="ml-4 text-sm underline">Back to your documents</button>}
      </div>
    </Layout>
  );
}
