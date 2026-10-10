import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

vi.mock('qrcode.react', () => ({ QRCodeCanvas: (p) => <canvas data-testid="qr" data-value={p.value} /> }));
vi.mock('./api', async (importActual) => ({
  ...(await importActual()),
  anchorFile: vi.fn(), getQrPayload: vi.fn(), getDocument: vi.fn(), getAudit: vi.fn(),
}));
vi.mock('./flows', async (importActual) => ({ ...(await importActual()), runAnchorFlow: vi.fn(), runRevokeFlow: vi.fn() }));
vi.mock('./chain', async (importActual) => ({ ...(await importActual()), chainConfigured: vi.fn(() => true) }));

import * as api from './api';
import * as flows from './flows';
import * as chain from './chain';
import Issue, { buildFields } from './pages/Issue';
import DocumentDetail from './pages/DocumentDetail';
import { AuthProvider } from './auth';

const ID = '00000000-0000-4000-8000-000000000001';
const TX = `0x${'ab'.repeat(32)}`;
const wrap = (ui, route = '/') => render(<MemoryRouter initialEntries={[route]}><AuthProvider>{ui}</AuthProvider></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  chain.chainConfigured.mockReturnValue(true);
});

describe('Issue page', () => {
  // The officer types only who the document belongs to. The institution, document type, ID
  // number and date of issue are printed on the document, and the server reads them off it.
  const fill = async (user, over = {}) => {
    const v = { Holder: 'Asha Menon', 'Date of birth': '2005-04-12', ...over };
    for (const [label, value] of Object.entries(v)) if (value) await user.type(screen.getByLabelText(new RegExp(`^${label}`)), value);
  };
  const upload = (user) => user.upload(screen.getByLabelText(/^The document/), new File(['x'], 'cert.png', { type: 'image/png' }));

  it('cannot be submitted until every required detail and the file are present, and says what is missing', async () => {
    const user = userEvent.setup();
    wrap(<Issue />);
    const submit = screen.getByRole('button', { name: 'Issue the document' });
    expect(submit).toBeDisabled();
    await fill(user, { Holder: '' });
    await upload(user);
    expect(submit).toBeDisabled();
    expect(screen.getByText(/Still needed: Holder/)).toBeInTheDocument();
    await user.type(screen.getByLabelText(/^Holder/), 'Asha');
    expect(submit).toBeEnabled();
  });

  it('sends only what the officer typed, trimmed, with a blank date of birth left out entirely', () => {
    expect(buildFields({ holder: '  Asha Menon ', dob: ' 12-04-2005 ' }))
      .toEqual({ holder: 'Asha Menon', payload: { dob: '12-04-2005' } });
    // A blank must be ABSENT, not empty: the server fills absent required fields from the
    // document, and an empty string would instead read as "the officer says this is blank".
    expect(buildFields({ holder: 'Asha Menon', dob: '   ' }))
      .toEqual({ holder: 'Asha Menon', payload: {} });
  });

  it('stores, signs, and shows the QR code for an issued document', async () => {
    const user = userEvent.setup();
    api.anchorFile.mockResolvedValue({ success: true, duplicate: false, hash: 'b'.repeat(64), contentHash: 'c'.repeat(64), document: { documentId: ID, status: 'STORED' } });
    flows.runAnchorFlow.mockImplementation(async (doc, onStatus) => { onStatus('Waiting for your wallet to sign…'); return { state: 'issued', document: { documentId: ID, status: 'ISSUED' } }; });
    api.getQrPayload.mockResolvedValue({ payload: '{"v":1}' });
    wrap(<Issue />);
    await fill(user);
    await upload(user);
    await user.click(screen.getByRole('button', { name: 'Issue the document' }));
    expect(await screen.findByText(/Issued and anchored/)).toBeInTheDocument();
    expect(screen.getByTestId('qr')).toHaveAttribute('data-value', '{"v":1}');
    expect(flows.runAnchorFlow).toHaveBeenCalledWith({ documentId: ID, contentHash: 'c'.repeat(64), sha256: 'b'.repeat(64) }, expect.any(Function));
    // No idNumber: the officer never types it, so it must not be sent. The server reads it
    // off the document, which is the only place it is authoritative.
    const sent = api.anchorFile.mock.calls[0][1];
    expect(sent).toMatchObject({ holder: 'Asha Menon', payload: { dob: '2005-04-12' } });
    expect(sent).not.toHaveProperty('idNumber');
    expect(screen.getByRole('link', { name: 'Open this document' })).toHaveAttribute('href', `/officer/documents/${ID}`);
  });

  it('shows the server\'s reason when the printed details disagree, and never opens the wallet', async () => {
    const user = userEvent.setup();
    api.anchorFile.mockRejectedValue({ response: { status: 422, data: { error: 'The details entered do not match the document: holder (entered A, printed B).' } } });
    wrap(<Issue />);
    await fill(user);
    await upload(user);
    await user.click(screen.getByRole('button', { name: 'Issue the document' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('do not match the document: holder');
    expect(flows.runAnchorFlow).not.toHaveBeenCalled();
    expect(screen.queryByTestId('qr')).toBeNull();
    expect(screen.getByRole('button', { name: 'Issue the document' })).toBeEnabled();   // can correct and retry
  });

  it('reports a duplicate and does not sign anything', async () => {
    const user = userEvent.setup();
    api.anchorFile.mockResolvedValue({ success: true, duplicate: true, message: 'This exact document was already stored. Nothing was written.', document: { documentId: ID } });
    wrap(<Issue />);
    await fill(user);
    await upload(user);
    await user.click(screen.getByRole('button', { name: 'Issue the document' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already stored');
    expect(flows.runAnchorFlow).not.toHaveBeenCalled();
  });

  it('says a refused signature plainly', async () => {
    const user = userEvent.setup();
    api.anchorFile.mockResolvedValue({ success: true, duplicate: false, hash: 'b'.repeat(64), contentHash: 'c'.repeat(64), document: { documentId: ID } });
    flows.runAnchorFlow.mockRejectedValue(new flows.FlowError('Signature rejected in the wallet.', { rejected: true }));
    wrap(<Issue />);
    await fill(user);
    await upload(user);
    await user.click(screen.getByRole('button', { name: 'Issue the document' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Signature rejected in the wallet.');
    expect(screen.queryByText(/Issued and anchored/)).toBeNull();
  });

  it('tells the officer the document was stored but not anchored when no contract is configured', async () => {
    const user = userEvent.setup();
    chain.chainConfigured.mockReturnValue(false);
    api.anchorFile.mockResolvedValue({ success: true, duplicate: false, hash: 'b'.repeat(64), contentHash: 'c'.repeat(64), document: { documentId: ID } });
    wrap(<Issue />);
    await fill(user);
    await upload(user);
    await user.click(screen.getByRole('button', { name: 'Issue the document' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('not anchored');
    expect(flows.runAnchorFlow).not.toHaveBeenCalled();
  });

  it('does not claim success when the chain says it failed or is still pending', async () => {
    const user = userEvent.setup();
    api.anchorFile.mockResolvedValue({ success: true, duplicate: false, hash: 'b'.repeat(64), contentHash: 'c'.repeat(64), document: { documentId: ID } });
    flows.runAnchorFlow.mockResolvedValue({ state: 'failed', document: { documentId: ID, failureReason: 'WRONG_DATA' } });
    wrap(<Issue />);
    await fill(user);
    await upload(user);
    await user.click(screen.getByRole('button', { name: 'Issue the document' }));
    expect(await screen.findByText(/did not succeed \(WRONG_DATA\)/)).toBeInTheDocument();
    expect(screen.queryByText(/Issued and anchored/)).toBeNull();
    expect(screen.queryByTestId('qr')).toBeNull();
  });
});

describe('Document page', () => {
  const issued = { documentId: ID, originalFileName: 'cert.png', status: 'ISSUED', sha256: 'b'.repeat(64), contentHash: 'c'.repeat(64), ocrCheck: 'MATCH',
    transactionHash: TX, chainId: 80002, blockNumber: 12, createdAt: '2026-06-15T10:00:00Z', issuedAt: '2026-06-15T10:05:00Z' };
  const open = () => wrap(<Routes><Route path="/officer/documents/:id" element={<DocumentDetail />} /></Routes>, `/officer/documents/${ID}`);

  beforeEach(() => {
    api.getDocument.mockResolvedValue({ document: issued });
    api.getAudit.mockResolvedValue({ events: [{ action: 'ISSUE', outcome: 'SUCCESS', reason: 'CHAIN_CONFIRMED', createdAt: '2026-06-15T10:05:00Z' }] });
    api.getQrPayload.mockResolvedValue({ payload: '{"v":1}' });
  });

  it('shows the record, an explorer link for the transaction, the QR code and the history', async () => {
    open();
    expect(await screen.findByText('cert.png')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /view on explorer/ })).toHaveAttribute('href', `https://amoy.polygonscan.com/tx/${TX}`);
    expect(await screen.findByTestId('qr')).toBeInTheDocument();
    expect(await screen.findByText('CHAIN_CONFIRMED')).toBeInTheDocument();
  });

  it('shows the revocation reason and time for a revoked document, with no revoke form and no QR code', async () => {
    api.getDocument.mockResolvedValue({ document: { ...issued, status: 'REVOKED', revokedAt: '2026-07-01T09:00:00Z', revocationReason: 'issued in error', revocationTxHash: `0x${'cd'.repeat(32)}` } });
    open();
    expect(await screen.findByText('issued in error')).toBeInTheDocument();
    expect(screen.getByText('Revoked', { selector: 'dt' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull();
    expect(screen.queryByTestId('qr')).toBeNull();
    expect(api.getQrPayload).not.toHaveBeenCalled();
  });

  it('says so when the document is not found', async () => {
    api.getDocument.mockRejectedValue({ response: { status: 404, data: {} } });
    open();
    expect(await screen.findByRole('alert')).toHaveTextContent('not found');
  });

  it('will not revoke without a reason', async () => {
    open();
    await screen.findByText('cert.png');
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeDisabled();
  });

  it('revokes through the wallet and then shows the document as revoked', async () => {
    const user = userEvent.setup();
    flows.runRevokeFlow.mockImplementation(async (doc, reason, onStatus) => {
      onStatus('Waiting for your wallet to sign…');
      return { state: 'revoked', document: { ...issued, status: 'REVOKED', revokedAt: '2026-07-01T09:00:00Z', revocationReason: reason } };
    });
    open();
    await screen.findByText('cert.png');
    await user.type(screen.getByLabelText('Reason'), 'issued in error');
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(await screen.findByText(/The document is revoked/)).toBeInTheDocument();
    expect(flows.runRevokeFlow).toHaveBeenCalledWith(expect.objectContaining({ documentId: ID, contentHash: issued.contentHash }), 'issued in error', expect.any(Function));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull());
    expect(screen.queryByTestId('qr')).toBeNull();     // a revoked document no longer shows a QR code to print
  });

  it('keeps the document ISSUED and says why when the wallet refuses or the contract rejects', async () => {
    const user = userEvent.setup();
    flows.runRevokeFlow.mockRejectedValue(new flows.FlowError('execution reverted: not the issuing institution'));
    open();
    await screen.findByText('cert.png');
    await user.type(screen.getByLabelText('Reason'), 'x');
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('not the issuing institution');
    expect(screen.getByText('Issued', { selector: 'span' })).toBeInTheDocument();
  });

  it('does not call a pending revocation done', async () => {
    const user = userEvent.setup();
    flows.runRevokeFlow.mockResolvedValue({ state: 'pending', document: issued });
    open();
    await screen.findByText('cert.png');
    await user.type(screen.getByLabelText('Reason'), 'x');
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(await screen.findByText(/not confirmed yet/)).toBeInTheDocument();
    expect(screen.queryByText(/The document is revoked/)).toBeNull();
  });
});
