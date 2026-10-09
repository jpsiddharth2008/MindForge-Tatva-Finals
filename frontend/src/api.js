// One place for the backend address and the issuer token.
// The token lives in memory only (not localStorage), so closing the tab logs the officer out.
import axios from 'axios';

export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';

let token = null;

export const hasToken = () => token !== null;
export const clearToken = () => { token = null; };

/** Exchanges credentials for a token. Throws a short message the UI can show. */
export async function login(username, password) {
  try {
    const res = await axios.post(`${API_URL}/api/auth/login`, { username, password });
    token = res.data.token;
  } catch (err) {
    token = null;
    throw new Error(err.response?.status === 401 ? 'Incorrect username or password.' : 'Could not reach the server.');
  }
}

export const hashFile = (formData) => axios.post(`${API_URL}/api/hash`, formData);

/** Issuer-only. A 401 clears the token so the app returns to the login screen. */
export async function anchorFile(formData) {
  try {
    return await axios.post(`${API_URL}/api/anchor`, formData, { headers: { Authorization: `Bearer ${token}` } });
  } catch (err) {
    if (err.response?.status === 401) clearToken();
    throw err;
  }
}

// The blockchain step is reported to the server, which checks it against the chain itself.
async function authedPost(path, body) {
  try {
    return (await axios.post(`${API_URL}${path}`, body, { headers: { Authorization: `Bearer ${token}` } })).data;
  } catch (err) {
    if (err.response?.status === 401) clearToken();
    throw err;
  }
}

/** A wallet transaction was sent. */
export const chainPending = (documentId, transactionHash) =>
  authedPost(`/api/documents/${documentId}/chain-pending`, { transactionHash });

/** Ask the server to check the transaction on chain. Resolves to { state: 'issued' | 'pending' | 'failed', document }. */
export const chainConfirmed = (documentId, transactionHash) =>
  authedPost(`/api/documents/${documentId}/chain-confirmed`, { transactionHash });

/** The wallet rejected or failed the transaction. */
export const chainFailed = (documentId, reason) =>
  authedPost(`/api/documents/${documentId}/chain-failed`, { reason });
