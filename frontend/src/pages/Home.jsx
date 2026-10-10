import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, FileSearch, Layers, Stamp } from 'lucide-react';
import Layout from '../components/Layout';

// Content-first, not a hero. Nine people in ten arrive here to check a document,
// so that path is the page and the officer path is a footnote - rather than two
// equal cards that make the visitor choose between things of unequal weight.
//
// The three tiers are stated plainly because the product's whole claim is that
// it survives a document leaving the digital channel. Saying so here means the
// verdict screen is not the first time anyone hears it.
const TIERS = [
  { icon: Layers, name: 'The exact file', body: 'A hash of the bytes. Matches only the original file, unchanged.' },
  { icon: FileSearch, name: 'What it says', body: 'The printed details are read back and hashed. A photocopy or a photograph still matches; an altered word does not.' },
  { icon: Stamp, name: 'How it looks', body: 'A perceptual fingerprint, advisory only. Catches a replaced photograph that the text would not reveal.' },
];

export default function Home() {
  return (
    <Layout bare>
      <section className="sheet p-7 sm:p-9">
        <p className="text-micro font-semibold uppercase tracking-widest text-accent">Document registry</p>
        <h1 className="mt-2 max-w-reading text-2xl font-bold leading-tight tracking-tight text-ink sm:text-3xl">
          Check whether a document is the one an authorised institution registered.
        </h1>
        <p className="mt-3 max-w-reading text-sm leading-relaxed text-ink-soft">
          Upload the document, or a photograph of it. No account and no wallet needed. The file is
          checked in memory and never stored.
        </p>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Link to="/verify" className="btn-primary">
            Verify a document
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
          <Link to="/officer/login" className="btn-ghost">Officer login</Link>
        </div>
      </section>

      <section className="mt-5 grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-3">
        {TIERS.map(({ icon: Icon, name, body }) => (
          <article key={name} className="bg-paper p-5">
            <Icon className="h-4.5 w-4.5 text-ink-faint" aria-hidden strokeWidth={1.75} />
            <h2 className="mt-2.5 text-label font-semibold text-ink">{name}</h2>
            <p className="mt-1 text-label leading-relaxed text-ink-soft">{body}</p>
          </article>
        ))}
      </section>

      <p className="mx-auto mt-5 max-w-reading text-center text-micro leading-relaxed text-slate-400">
        A document that has been printed, scanned or forwarded has different bytes but says the same
        thing. Reading all three together is what separates a genuine copy from an altered one.
      </p>
    </Layout>
  );
}
