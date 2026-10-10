import React from 'react';
import { Link } from 'react-router-dom';
import Layout from '../components/Layout';

export default function NotFound() {
  return (
    <Layout>
      <h1 className="text-2xl font-bold mb-2">Page not found</h1>
      <p className="text-ink-soft mb-4">There is nothing at this address.</p>
      <Link to="/" className="font-semibold text-accent underline underline-offset-2 hover:text-accent-hover">Go to the home page</Link>
    </Layout>
  );
}
