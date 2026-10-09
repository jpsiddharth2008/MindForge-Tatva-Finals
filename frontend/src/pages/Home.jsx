import React from 'react';
import { Link } from 'react-router-dom';
import { Briefcase, User } from 'lucide-react';
import Layout from '../components/Layout';

export default function Home() {
  return (
    <Layout>
      <div className="text-center mb-8">
        <h1 className="text-4xl font-extrabold mb-2">MindForge</h1>
        <p className="text-slate-600">Check whether a document is the one an authorised institution registered, and whether it has been altered.</p>
      </div>
      <div className="grid md:grid-cols-2 gap-6">
        <section className="border border-slate-200 rounded-xl p-6">
          <User className="w-8 h-8 text-purple-600 mb-3" aria-hidden />
          <h2 className="text-xl font-bold mb-1">Verify a document</h2>
          <p className="text-slate-600 text-sm mb-4">Upload a document, or a photo of it. No account and no wallet needed. The file is checked in memory and never stored.</p>
          <Link to="/verify" className="block text-center bg-[#111827] text-white py-2 rounded-lg font-semibold hover:bg-black">Verify a document</Link>
        </section>
        <section className="border border-slate-200 rounded-xl p-6">
          <Briefcase className="w-8 h-8 text-blue-600 mb-3" aria-hidden />
          <h2 className="text-xl font-bold mb-1">Issuing officers</h2>
          <p className="text-slate-600 text-sm mb-4">Issue documents, see what you have issued, and revoke a document if it must be withdrawn.</p>
          <Link to="/officer/login" className="block text-center bg-slate-200 text-slate-900 py-2 rounded-lg font-semibold hover:bg-slate-300">Officer login</Link>
        </section>
      </div>
    </Layout>
  );
}
