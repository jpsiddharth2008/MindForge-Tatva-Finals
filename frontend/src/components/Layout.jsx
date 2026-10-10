import React from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { useAuth } from '../auth';

/**
 * The page shell: a header with the name and, for a logged-in officer, the navigation.
 *
 * The dark field is chrome and the white panel is the document. Keeping that
 * distinction literal means a user never has to work out which part of the
 * screen is the thing being judged.
 */
export default function Layout({ title, lede, children, narrow = false, bare = false }) {
  const { loggedIn, logout } = useAuth();
  const navigate = useNavigate();

  const link = ({ isActive }) =>
    `rounded px-2.5 py-1.5 text-label font-medium transition-colors ${
      isActive ? 'bg-canvas-raised text-white' : 'text-slate-300 hover:bg-canvas-raised/60 hover:text-white'
    }`;

  return (
    <div className="min-h-screen bg-canvas">
      {/* Keyboard and screen-reader users should not have to tab the whole nav
          on every page before reaching the form they came for. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50
                   focus:rounded focus:bg-paper focus:px-3 focus:py-2 focus:text-label focus:font-semibold"
      >
        Skip to content
      </a>

      <header className="on-canvas border-b border-canvas-line">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <Link to="/" className="flex items-center gap-2 text-white">
            <ShieldCheck className="h-5 w-5 text-accent" aria-hidden />
            <span className="text-base font-bold tracking-tight">MindForge</span>
            <span className="hidden text-micro font-medium uppercase tracking-wider text-slate-400 sm:inline">
              Document registry
            </span>
          </Link>

          <nav aria-label="Main" className="flex flex-wrap items-center gap-1">
            <NavLink to="/verify" className={link}>Verify a document</NavLink>
            {loggedIn ? (
              <>
                <NavLink to="/officer" end className={link}>Dashboard</NavLink>
                <NavLink to="/officer/issue" className={link}>Issue</NavLink>
                <button
                  type="button"
                  onClick={() => { logout(); navigate('/'); }}
                  className="rounded px-2.5 py-1.5 text-label font-medium text-slate-300 transition-colors hover:bg-canvas-raised/60 hover:text-white"
                >
                  Log out
                </button>
              </>
            ) : (
              <NavLink to="/officer/login" className={link}>Officer login</NavLink>
            )}
          </nav>
        </div>
      </header>

      <main id="main" className={`mx-auto px-4 py-8 ${narrow ? 'max-w-xl' : 'max-w-5xl'}`}>
        {title && (
          <div className="mb-5">
            <h1 className="text-xl font-bold tracking-tight text-white">{title}</h1>
            {lede && <p className="mt-1 max-w-reading text-label text-slate-400">{lede}</p>}
          </div>
        )}
        {/* bare: the page composes its own panels rather than sitting in one. */}
        {bare ? children : <div className="sheet p-6">{children}</div>}
      </main>
    </div>
  );
}

/**
 * Status of a document in the issuing pipeline. A dot carries the state as well
 * as the colour, so it is still distinguishable in greyscale or to a colourblind
 * reader - colour alone must never be the only signal.
 */
export function StatusBadge({ status }) {
  const tone = {
    ISSUED: 'bg-verdict-original-bg text-verdict-original',
    REVOKED: 'bg-verdict-revoked-bg text-verdict-revoked',
    FAILED: 'bg-verdict-content-bg text-verdict-content',
    STORED: 'bg-paper-sunk text-ink-soft',
    PENDING: 'bg-verdict-visual-bg text-verdict-visual',
    BLOCKCHAIN_PENDING: 'bg-verdict-visual-bg text-verdict-visual',
  }[status] || 'bg-paper-sunk text-ink-soft';

  const label = { BLOCKCHAIN_PENDING: 'Awaiting chain', STORED: 'Uploaded', PENDING: 'Processing' }[status]
    || (status ? status[0] + status.slice(1).toLowerCase() : 'Unknown');

  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-micro font-semibold ${tone}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
      {label}
    </span>
  );
}
