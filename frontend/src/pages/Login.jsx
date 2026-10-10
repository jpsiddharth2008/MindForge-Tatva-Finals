import React, { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import Layout from '../components/Layout';
import { login } from '../api';

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try {
      await login(username, password);          // the server checks the password, never this file
      setPassword('');
      navigate(location.state?.from || '/officer', { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Layout narrow title="Officer login">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <label className="field-label" htmlFor="u">Username</label>
        <input id="u" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" className="field" />
        <label className="field-label" htmlFor="p">Password</label>
        <input id="p" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" className="field" />
        {error && <p role="alert" className="text-label font-medium text-verdict-content">{error}</p>}
        <button type="submit" disabled={busy || !username || !password} className="btn-primary btn-block py-3">
          {busy ? 'Checking…' : 'Log in'}
        </button>
      </form>
    </Layout>
  );
}
