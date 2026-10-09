import React, { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import Layout from '../components/Layout';
import VerdictCard from '../components/VerdictCard';
import QrScanner from '../components/QrScanner';
import { verifyDocument, errorMessage } from '../api';

const ACCEPT = '.pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg';

/** Public. No login, no wallet: the server reads the document, compares it with the registry, and says what it found. */
export default function Verify({ Scanner }) {
  const [file, setFile] = useState(null);
  const [qr, setQr] = useState('');
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');

  const run = async () => {
    if (!file || busy) return;
    setBusy(true); setError(''); setReport(null);
    try {
      setReport(await verifyDocument(file, qr.trim() || undefined));
    } catch (err) {
      setError(err?.response?.status === 429 ? 'Too many checks in a short time. Please wait a minute and try again.' : errorMessage(err, 'The document could not be checked.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Layout narrow title="Verify a document">
      <div className="flex items-center gap-3 mb-4">
        <ShieldCheck className="w-8 h-8 text-slate-700" aria-hidden />
        <p className="text-sm text-slate-600">Upload the document or a photo of it (PDF, PNG or JPEG). It is checked in memory and never stored.</p>
      </div>
      <label className="block text-sm font-semibold mb-1" htmlFor="doc">The document</label>
      <input id="doc" type="file" accept={ACCEPT} onChange={(e) => { setFile(e.target.files?.[0] || null); setReport(null); setError(''); }}
        className="block w-full text-sm text-slate-500 border border-dashed border-slate-300 rounded-lg p-3 mb-4" />

      <details className="mb-4" open={!!qr}>
        <summary className="text-sm font-semibold cursor-pointer">The document has a QR code (optional)</summary>
        <p className="text-xs text-slate-600 my-2">A QR code is checked <em>against the document itself</em>. A real code copied onto a different document is rejected.</p>
        <QrScanner onResult={setQr} Scanner={Scanner} />
        <label className="block text-xs font-semibold mt-3" htmlFor="qrtext">QR code text</label>
        <textarea id="qrtext" value={qr} onChange={(e) => setQr(e.target.value)} rows={2} placeholder="Filled in when you scan a code, or paste its text"
          className="w-full text-xs border border-slate-300 rounded-lg p-2 font-mono" />
      </details>

      <button onClick={run} disabled={!file || busy} className="w-full bg-[#111827] text-white py-3 rounded-lg font-bold hover:bg-black disabled:opacity-50">
        {busy ? 'Checking…' : 'Verify'}
      </button>
      <div aria-live="polite" className="mt-4">
        {error && <p role="alert" className="text-red-700 text-sm">{error}</p>}
        <VerdictCard report={report} />
      </div>
    </Layout>
  );
}
