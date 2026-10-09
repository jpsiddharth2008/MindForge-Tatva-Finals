import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import Layout, { StatusBadge } from '../components/Layout';
import { listDocuments, errorMessage } from '../api';

const FILTERS = [['', 'All'], ['ISSUED', 'Issued'], ['REVOKED', 'Revoked'], ['BLOCKCHAIN_PENDING', 'Awaiting chain'], ['STORED', 'Uploaded'], ['FAILED', 'Failed']];
const when = (iso) => (iso ? new Date(iso).toLocaleString() : '—');

/** The officer's own documents: counts per status, a filter, and a page at a time (the server pages, so this stays fast with many). */
export default function Dashboard() {
  const [status, setStatus] = useState('');
  const [docs, setDocs] = useState([]);
  const [counts, setCounts] = useState({});
  const [next, setNext] = useState(null);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (cursor) => {
    if (cursor) setMore(true); else setLoading(true);
    setError('');
    try {
      const r = await listDocuments({ status: status || undefined, cursor });
      setDocs((prev) => (cursor ? [...prev, ...r.documents] : r.documents));
      setCounts(r.counts || {});
      setNext(r.nextCursor || null);
    } catch (err) {
      // a 401 sends the officer to the login page (api.js forgets the token); anything else is shown
      if (err?.response?.status !== 401) setError(errorMessage(err, 'Your documents could not be loaded.'));
    } finally {
      setLoading(false); setMore(false);
    }
  }, [status]);

  useEffect(() => { load(); }, [load]);

  return (
    <Layout title="Your documents">
      <div className="flex flex-wrap gap-3 mb-4" aria-label="Totals">
        {['ISSUED', 'REVOKED', 'BLOCKCHAIN_PENDING', 'FAILED'].map((s) => (
          <div key={s} className="border border-slate-200 rounded-lg px-4 py-2 min-w-[7rem]">
            <div className="text-2xl font-extrabold" data-testid={`count-${s}`}>{counts[s] ?? 0}</div>
            <StatusBadge status={s} />
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div role="group" aria-label="Filter by status" className="flex flex-wrap gap-1">
          {FILTERS.map(([value, label]) => (
            <button key={value || 'all'} onClick={() => setStatus(value)} aria-pressed={status === value}
              className={`px-3 py-1 rounded-lg text-sm font-semibold ${status === value ? 'bg-[#111827] text-white' : 'bg-slate-100 text-slate-800 hover:bg-slate-200'}`}>{label}</button>
          ))}
        </div>
        <Link to="/officer/issue" className="bg-[#111827] text-white px-4 py-2 rounded-lg font-semibold hover:bg-black">Issue a document</Link>
      </div>

      {loading && <p role="status" className="text-slate-600">Loading…</p>}
      {error && (
        <div role="alert" className="text-red-700 text-sm mb-2">{error} <button onClick={() => load()} className="underline font-semibold">Try again</button></div>
      )}
      {!loading && !error && docs.length === 0 && (
        <p className="text-slate-600 py-6 text-center">{status ? 'No documents with this status.' : 'You have not issued any documents yet.'}</p>
      )}
      {docs.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead><tr className="border-b border-slate-200 text-slate-600"><th className="py-2 pr-3">File</th><th className="pr-3">Status</th><th className="pr-3">Created</th><th /></tr></thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.documentId} className="border-b border-slate-100">
                  <td className="py-2 pr-3 break-all">{d.originalFileName || d.documentId}</td>
                  <td className="pr-3"><StatusBadge status={d.status} /></td>
                  <td className="pr-3 whitespace-nowrap">{when(d.createdAt)}</td>
                  <td><Link to={`/officer/documents/${d.documentId}`} className="text-blue-700 font-semibold underline">Open</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {next && <button onClick={() => load(next)} disabled={more} className="mt-3 bg-slate-200 text-slate-900 px-4 py-2 rounded-lg font-semibold hover:bg-slate-300 disabled:opacity-50">{more ? 'Loading…' : 'Load more'}</button>}
    </Layout>
  );
}
