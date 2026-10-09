import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('axios', () => ({ default: { post: vi.fn(), get: vi.fn() } }));
import axios from 'axios';
import * as api from './api';

const reject = (status, data) => Object.assign(new Error('request failed'), { response: { status, data } });

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => api.clearToken());

describe('login', () => {
  it('keeps the token in memory and tells listeners', async () => {
    axios.post.mockResolvedValue({ data: { token: 'tok' } });
    const seen = [];
    const off = api.onAuthChange((v) => seen.push(v));
    await api.login('officer', 'pw');
    expect(api.hasToken()).toBe(true);
    expect(seen).toEqual([true]);
    off();
    expect(localStorage.length + sessionStorage.length).toBe(0);   // never written to browser storage
  });

  it.each([
    [401, 'Incorrect username or password.'],
    [429, 'Too many attempts. Please wait a few minutes.'],
    [500, 'Could not reach the server.'],
  ])('turns a %i into a plain message and leaves the user logged out', async (status, message) => {
    axios.post.mockRejectedValue(reject(status));
    await expect(api.login('o', 'p')).rejects.toThrow(message);
    expect(api.hasToken()).toBe(false);
  });
});

describe('errorMessage', () => {
  it('prefers the server\'s own message, then a fallback, and names a network failure', () => {
    expect(api.errorMessage(reject(422, { error: 'The details entered do not match.' }))).toBe('The details entered do not match.');
    expect(api.errorMessage(reject(500, {}), 'fallback')).toBe('fallback');
    expect(api.errorMessage({ request: {} })).toBe('Could not reach the server.');
    expect(api.errorMessage(new Error('boom'))).toBe('boom');
  });
});

describe('authenticated calls', () => {
  beforeEach(async () => { axios.post.mockResolvedValueOnce({ data: { token: 'tok' } }); await api.login('o', 'p'); });

  it('sends the bearer token', async () => {
    axios.get.mockResolvedValue({ data: { documents: [] } });
    await api.listDocuments({ status: 'ISSUED', cursor: 'c1' });
    const [url, opts] = axios.get.mock.calls[0];
    expect(url).toMatch(/\/api\/documents$/);
    expect(opts.headers.Authorization).toBe('Bearer tok');
    expect(opts.params).toEqual({ status: 'ISSUED', cursor: 'c1', limit: undefined });
  });

  it('forgets the token when the server says the session is over', async () => {
    axios.get.mockRejectedValue(reject(401));
    await expect(api.getDocument('x')).rejects.toBeTruthy();
    expect(api.hasToken()).toBe(false);
  });

  it('does NOT log out on other failures', async () => {
    axios.get.mockRejectedValue(reject(500));
    await expect(api.getDocument('x')).rejects.toBeTruthy();
    expect(api.hasToken()).toBe(true);
  });

  it('sends the document details as JSON next to the file', async () => {
    axios.post.mockResolvedValue({ data: { success: true } });
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    await api.anchorFile(file, { holder: 'A', payload: { cgpa: '8' } });
    const form = axios.post.mock.calls.at(-1)[1];
    expect(form.get('file').name).toBe('a.png');
    expect(JSON.parse(form.get('fields'))).toEqual({ holder: 'A', payload: { cgpa: '8' } });
  });

  it('reports the chain steps to the right routes', async () => {
    axios.post.mockResolvedValue({ data: {} });
    const hash = `0x${'a'.repeat(64)}`;
    await api.chainPending('id1', hash);
    await api.chainConfirmed('id1', hash);
    await api.chainFailed('id1', 'USER_REJECTED');
    await api.confirmRevocation('id1', hash);
    const calls = axios.post.mock.calls.slice(-4).map(([url, body]) => [url.replace(/^.*\/api/, '/api'), body]);
    expect(calls).toEqual([
      ['/api/documents/id1/chain-pending', { transactionHash: hash }],
      ['/api/documents/id1/chain-confirmed', { transactionHash: hash }],
      ['/api/documents/id1/chain-failed', { reason: 'USER_REJECTED' }],
      ['/api/documents/id1/revoke', { transactionHash: hash }],
    ]);
  });
});

describe('verifyDocument', () => {
  it('works without a login and sends the QR text only when there is one', async () => {
    axios.post.mockResolvedValue({ data: { verdict: 'NOT_REGISTERED' } });
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    expect(await api.verifyDocument(file)).toEqual({ verdict: 'NOT_REGISTERED' });
    let [, form, opts] = axios.post.mock.calls[0];
    expect(form.get('qr')).toBeNull();
    expect(opts.headers.Authorization).toBeUndefined();
    await api.verifyDocument(file, '{"v":1}');
    [, form] = axios.post.mock.calls[1];
    expect(form.get('qr')).toBe('{"v":1}');
  });

  it('sends the token when an officer is logged in (they are shown more)', async () => {
    axios.post.mockResolvedValueOnce({ data: { token: 'tok' } });
    await api.login('o', 'p');
    axios.post.mockResolvedValue({ data: {} });
    await api.verifyDocument(new File(['x'], 'a.png'));
    expect(axios.post.mock.calls.at(-1)[2].headers.Authorization).toBe('Bearer tok');
  });
});
