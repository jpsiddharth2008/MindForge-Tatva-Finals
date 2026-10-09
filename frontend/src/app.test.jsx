import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('axios', () => ({ default: { post: vi.fn(), get: vi.fn() } }));
import axios from 'axios';
import App from './App';
import Verify from './pages/Verify';
import { AuthProvider } from './auth';
import { clearToken } from './api';

const fail = (status, data = {}) => Object.assign(new Error('request failed'), { response: { status, data } });
const doc = (n, over = {}) => ({ documentId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, originalFileName: `cert-${n}.png`, status: 'ISSUED', createdAt: '2026-06-15T10:00:00Z', ...over });

function renderApp(route = '/') {
  return render(<MemoryRouter initialEntries={[route]}><AuthProvider><App /></AuthProvider></MemoryRouter>);
}

async function logIn(user) {
  await user.type(screen.getByLabelText('Username'), 'officer');
  await user.type(screen.getByLabelText('Password'), 'correct horse');
  await user.click(screen.getByRole('button', { name: 'Log in' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  axios.post.mockImplementation(async (url) => {
    if (url.endsWith('/api/auth/login')) return { data: { token: 'tok' } };
    throw fail(404);
  });
  axios.get.mockImplementation(async (url) => {
    if (url.endsWith('/api/documents')) return { data: { documents: [], counts: {}, nextCursor: null } };
    throw fail(404);
  });
});
afterEach(() => clearToken());

describe('routing and access', () => {
  it('the home page offers verification (no login) and officer login', () => {
    renderApp('/');
    const main = within(screen.getByRole('main'));
    expect(main.getByRole('link', { name: 'Verify a document' })).toHaveAttribute('href', '/verify');
    expect(main.getByRole('link', { name: 'Officer login' })).toHaveAttribute('href', '/officer/login');
  });

  it('verification needs no login and no wallet', () => {
    renderApp('/verify');
    expect(screen.getByLabelText('The document')).toBeInTheDocument();
    expect(screen.queryByLabelText('Username')).toBeNull();
  });

  it.each(['/officer', '/officer/issue', '/officer/documents/00000000-0000-4000-8000-000000000001'])('sends a logged-out visitor from %s to the login page', (path) => {
    renderApp(path);
    expect(screen.getByRole('heading', { name: 'Officer login' })).toBeInTheDocument();
    expect(axios.get).not.toHaveBeenCalled();       // nothing was requested on the visitor's behalf
  });

  it('brings the officer back to the page they asked for after logging in', async () => {
    const user = userEvent.setup();
    renderApp('/officer/issue');
    await logIn(user);
    expect(await screen.findByRole('heading', { name: 'Issue a document' })).toBeInTheDocument();
  });

  it('logging in shows the dashboard, and logging out hides it again', async () => {
    const user = userEvent.setup();
    renderApp('/officer/login');
    await logIn(user);
    expect(await screen.findByRole('heading', { name: 'Your documents' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Log out' }));
    expect(screen.getByRole('heading', { name: 'MindForge' })).toBeInTheDocument();   // back on the home page
    expect(screen.queryByRole('heading', { name: 'Your documents' })).toBeNull();
    expect(within(screen.getByRole('navigation')).getByRole('link', { name: 'Officer login' })).toBeInTheDocument();
  });

  it('shows a wrong password plainly and clears nothing the server did not', async () => {
    axios.post.mockRejectedValue(fail(401));
    const user = userEvent.setup();
    renderApp('/officer/login');
    await logIn(user);
    expect(await screen.findByRole('alert')).toHaveTextContent('Incorrect username or password.');
    expect(screen.getByRole('heading', { name: 'Officer login' })).toBeInTheDocument();
  });

  it('returns to the login page when the server ends the session', async () => {
    const user = userEvent.setup();
    renderApp('/officer/login');
    await logIn(user);
    await screen.findByRole('heading', { name: 'Your documents' });
    axios.get.mockRejectedValue(fail(401));
    await user.click(screen.getByRole('button', { name: 'Failed' }));        // triggers a reload that the server refuses
    expect(await screen.findByRole('heading', { name: 'Officer login' })).toBeInTheDocument();
  });

  it('has a not-found page', () => {
    renderApp('/nowhere');
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });
});

describe('dashboard', () => {
  const login = async (user) => { renderApp('/officer/login'); await logIn(user); };

  it('says when there is nothing yet', async () => {
    await login(userEvent.setup());
    expect(await screen.findByText('You have not issued any documents yet.')).toBeInTheDocument();
    expect(screen.getByTestId('count-ISSUED')).toHaveTextContent('0');
  });

  it('shows the counts and the documents, each with a link to its page', async () => {
    axios.get.mockResolvedValue({ data: { documents: [doc(1), doc(2, { status: 'REVOKED' })], counts: { ISSUED: 1, REVOKED: 1 }, nextCursor: null } });
    await login(userEvent.setup());
    expect(await screen.findByText('cert-1.png')).toBeInTheDocument();
    expect(screen.getByTestId('count-REVOKED')).toHaveTextContent('1');
    const row = screen.getByText('cert-2.png').closest('tr');
    expect(within(row).getByText('Revoked')).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/officer/documents/00000000-0000-4000-8000-000000000002');
  });

  it('asks the server for the chosen status', async () => {
    const user = userEvent.setup();
    await login(user);
    await screen.findByText('You have not issued any documents yet.');
    await user.click(screen.getByRole('button', { name: 'Revoked' }));
    await waitFor(() => expect(axios.get.mock.calls.at(-1)[1].params.status).toBe('REVOKED'));
    expect(await screen.findByText('No documents with this status.')).toBeInTheDocument();
  });

  it('loads the next page with the cursor and adds to the list', async () => {
    const user = userEvent.setup();
    axios.get.mockImplementation(async (url, opts) => ({
      data: opts.params.cursor
        ? { documents: [doc(3)], counts: { ISSUED: 3 }, nextCursor: null }
        : { documents: [doc(1), doc(2)], counts: { ISSUED: 3 }, nextCursor: 'a'.repeat(24) },
    }));
    await login(user);
    await screen.findByText('cert-2.png');
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('cert-3.png')).toBeInTheDocument();
    expect(screen.getByText('cert-1.png')).toBeInTheDocument();                 // kept
    expect(axios.get.mock.calls.at(-1)[1].params.cursor).toBe('a'.repeat(24));
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();     // no more pages
  });

  it('shows a load failure with a way to try again', async () => {
    const user = userEvent.setup();
    axios.get.mockRejectedValueOnce(fail(500));
    await login(user);
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded');
    axios.get.mockResolvedValue({ data: { documents: [doc(1)], counts: { ISSUED: 1 }, nextCursor: null } });
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('cert-1.png')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('public verification page', () => {
  const png = () => new File(['x'], 'cert.png', { type: 'image/png' });
  const report = (verdict, extra = {}) => ({ success: true, verdict, confidence: 'HIGH', reason: 'because', ...extra });

  it('cannot be submitted without a document', () => {
    render(<MemoryRouter><AuthProvider><Verify /></AuthProvider></MemoryRouter>);
    expect(screen.getByRole('button', { name: 'Verify' })).toBeDisabled();
  });

  it('sends the document and shows the verdict', async () => {
    const user = userEvent.setup();
    axios.post.mockResolvedValue({ data: report('AUTHENTIC_ORIGINAL', { anchor: { issuer: 'NIT Calicut' } }) });
    render(<MemoryRouter><AuthProvider><Verify /></AuthProvider></MemoryRouter>);
    await user.upload(screen.getByLabelText('The document'), png());
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText('Authentic original')).toBeInTheDocument();
    const form = axios.post.mock.calls[0][1];
    expect(form.get('file').name).toBe('cert.png');
    expect(form.get('qr')).toBeNull();
  });

  it('sends the QR text with the document when there is one', async () => {
    const user = userEvent.setup();
    axios.post.mockResolvedValue({ data: report('QR_MISMATCH') });
    render(<MemoryRouter><AuthProvider><Verify /></AuthProvider></MemoryRouter>);
    await user.upload(screen.getByLabelText('The document'), png());
    await user.type(screen.getByLabelText('QR code text'), 'qr-text');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText('QR code does not match')).toBeInTheDocument();
    expect(axios.post.mock.calls[0][1].get('qr')).toBe('qr-text');
  });

  it('clears the previous verdict when a different file is chosen', async () => {
    const user = userEvent.setup();
    axios.post.mockResolvedValue({ data: report('REVOKED', { revocation: { reason: 'withdrawn' } }) });
    render(<MemoryRouter><AuthProvider><Verify /></AuthProvider></MemoryRouter>);
    await user.upload(screen.getByLabelText('The document'), png());
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    await screen.findByText('Revoked', { selector: 'div' });
    await user.upload(screen.getByLabelText('The document'), new File(['y'], 'other.png', { type: 'image/png' }));
    expect(screen.queryByTestId('revocation')).toBeNull();
  });

  it('explains a rate limit and a server error without raw details', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><AuthProvider><Verify /></AuthProvider></MemoryRouter>);
    await user.upload(screen.getByLabelText('The document'), png());
    axios.post.mockRejectedValueOnce(fail(429));
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many checks');
    axios.post.mockRejectedValueOnce(fail(500, { error: 'Something went wrong on our side.' }));
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong on our side.'));
  });

  it('cannot be double-submitted while a check is running', async () => {
    const user = userEvent.setup();
    let release;
    axios.post.mockReturnValue(new Promise((resolve) => { release = () => resolve({ data: report('NOT_REGISTERED') }); }));
    render(<MemoryRouter><AuthProvider><Verify /></AuthProvider></MemoryRouter>);
    await user.upload(screen.getByLabelText('The document'), png());
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(screen.getByRole('button', { name: 'Checking…' })).toBeDisabled();
    release();
    await screen.findByText('Not registered');
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  it('fills in the QR text from the scanner', async () => {
    const user = userEvent.setup();
    const Scanner = class { scanFile() { return Promise.resolve('scanned-text'); } stop() { return Promise.resolve(); } clear() {} };
    render(<MemoryRouter><AuthProvider><Verify Scanner={Scanner} /></AuthProvider></MemoryRouter>);
    await user.click(screen.getByText('The document has a QR code (optional)'));
    await user.upload(document.querySelector('input[accept="image/*"]'), new File(['x'], 'qr.png', { type: 'image/png' }));
    await waitFor(() => expect(screen.getByLabelText('QR code text')).toHaveValue('scanned-text'));
  });
});
