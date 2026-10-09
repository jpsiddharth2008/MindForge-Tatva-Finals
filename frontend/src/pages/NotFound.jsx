import React from 'react';
import { Link } from 'react-router-dom';
import Layout from '../components/Layout';

export default function NotFound() {
  return (
    <Layout>
      <h1 className="text-2xl font-bold mb-2">Page not found</h1>
      <p className="text-slate-600 mb-4">There is nothing at this address.</p>
      <Link to="/" className="text-blue-700 font-semibold underline">Go to the home page</Link>
    </Layout>
  );
}
