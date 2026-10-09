import React from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { useAuth } from '../auth';

/** The page shell: a header with the name and, for a logged-in officer, the navigation. */
export default function Layout({ title, children, narrow = false }) {
  const { loggedIn, logout } = useAuth();
  const navigate = useNavigate();
  const link = ({ isActive }) => `px-3 py-1 rounded-lg font-medium ${isActive ? 'bg-white text-slate-900' : 'text-slate-200 hover:text-white'}`;
  return (
    <div className="min-h-screen bg-[#344155] font-sans text-slate-900">
      <header className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-white">
        <Link to="/" className="flex items-center gap-2 text-xl font-extrabold tracking-tight"><ShieldCheck className="w-6 h-6" aria-hidden /> MindForge</Link>
        <nav aria-label="Main" className="flex flex-wrap items-center gap-1">
          <NavLink to="/verify" className={link}>Verify a document</NavLink>
          {loggedIn ? (
            <>
              <NavLink to="/officer" end className={link}>Dashboard</NavLink>
              <NavLink to="/officer/issue" className={link}>Issue</NavLink>
              <button onClick={() => { logout(); navigate('/'); }} className="px-3 py-1 rounded-lg font-medium text-slate-200 hover:text-white">Log out</button>
            </>
          ) : <NavLink to="/officer/login" className={link}>Officer login</NavLink>}
        </nav>
      </header>
      <main className={`mx-auto p-4 ${narrow ? 'max-w-lg' : 'max-w-4xl'}`}>
        {title && <h1 className="text-2xl font-bold text-white mb-4">{title}</h1>}
        <div className="bg-white rounded-xl shadow-2xl p-6">{children}</div>
      </main>
    </div>
  );
}

export function StatusBadge({ status }) {
  const colour = { ISSUED: 'bg-green-100 text-green-800', REVOKED: 'bg-rose-100 text-rose-800', FAILED: 'bg-red-100 text-red-800',
    STORED: 'bg-slate-100 text-slate-700', PENDING: 'bg-amber-100 text-amber-800', BLOCKCHAIN_PENDING: 'bg-amber-100 text-amber-800' }[status] || 'bg-slate-100 text-slate-700';
  const label = { BLOCKCHAIN_PENDING: 'Awaiting chain', STORED: 'Uploaded', PENDING: 'Processing' }[status] || (status ? status[0] + status.slice(1).toLowerCase() : 'Unknown');
  return <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${colour}`}>{label}</span>;
}
