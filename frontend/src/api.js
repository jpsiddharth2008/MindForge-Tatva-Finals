// One place for talking to the backend, and for the issuer's token.
// The token lives in memory only (not localStorage or cookies), so closing the tab logs the officer out.
import axios from 'axios';
import { API_URL } from './config';

export { API_URL };

let token = null;
const listeners = new Set();

export const hasToken = () => token !== null;
export const clearToken = () => { token = null; listeners.forEach((fn) => fn(false)); };
/** Lets the UI react when the officer logs in or out (or the server says the session ended). */
export function onAuthChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

const authHeader = () => (token ? { Authorization: `Bearer ${token}` } : {});

/** The server's own message when it gave one (it is always written to be safe to show), otherwise a plain fallback. */
export function errorMessage(err, fallback = 'Something went wrong. Please try again.') {
  if (err?.response?.data?.error) return err.response.data.error;
  if (err?.response) return fallback;
  if (err?.request) return 'Could not reach the server.';
  return err?.message || fallback;
}
export const isUnauthorized = (err) => err?.response?.status === 401;

/** Exchanges credentials for a token. Throws a short message the UI can show. */
export async function login(username, password) {
  try {
    const res = await axios.post(`${API_URL}/api/auth/login`, { username, password });
    token = res.data.token;
    listeners.forEach((fn) => fn(true));
  } catch (err) {
    token = null;
    throw new Error(err.response?.status === 401 ? 'Incorrect username or password.'
      : err.response?.status === 429 ? 'Too many attempts. Please wait a few minutes.' : 'Could not reach the server.');
  }
}

// A 401 from the server means the session is over: forget the token so the app returns to the login page.
async function authed(request) {
  try {
    return (await request()).data;
  } catch (err) {
    if (isUnauthorized(err)) clearToken();
    throw err;
  }
}

export const hashFile = (formData) => axios.post(`${API_URL}/api/hash`, formData);

/** Issuer-only. `fields` (an object) is the document's details; the server reads the printed text back and checks it agrees. */
export function anchorFile(file, fields) {
  const form = new FormData();
  form.append('file', file);
  if (fields) form.append('fields', JSON.stringify(fields));
  return authed(() => axios.post(`${API_URL}/api/anchor`, form, { headers: authHeader() }));
}

/**
 * Public verification. If an officer is logged in the token is sent, which only matters for what they are shown
 * (they see the true value of a changed field; the public does not).
 */
export async function verifyDocument(file, qrText) {
  const form = new FormData();
  form.append('file', file);
  if (qrText) form.append('qr', qrText);
  return (await axios.post(`${API_URL}/api/verify`, form, { headers: authHeader() })).data;
}

export const listDocuments = ({ status, cursor, limit } = {}) =>
  authed(() => axios.get(`${API_URL}/api/documents`, { headers: authHeader(), params: { status, cursor, limit } }));
export const getDocument = (id) => authed(() => axios.get(`${API_URL}/api/documents/${id}`, { headers: authHeader() }));
export const getAudit = (id) => authed(() => axios.get(`${API_URL}/api/documents/${id}/audit`, { headers: authHeader() }));
export const getQrPayload = (id) => authed(() => axios.get(`${API_URL}/api/documents/${id}/qr`, { headers: authHeader() }));

// The blockchain step is reported to the server, which checks it against the chain itself.
const post = (path, body) => authed(() => axios.post(`${API_URL}${path}`, body, { headers: authHeader() }));
export const chainPending = (documentId, transactionHash) => post(`/api/documents/${documentId}/chain-pending`, { transactionHash });
/** Resolves to { state: 'issued' | 'pending' | 'failed', document }. */
export const chainConfirmed = (documentId, transactionHash) => post(`/api/documents/${documentId}/chain-confirmed`, { transactionHash });
export const chainFailed = (documentId, reason) => post(`/api/documents/${documentId}/chain-failed`, { reason });
/** After the wallet sent revoke(): the server checks the chain. Resolves to { state: 'revoked' | 'pending' | 'failed', document }. */
export const confirmRevocation = (documentId, transactionHash) => post(`/api/documents/${documentId}/revoke`, { transactionHash });
