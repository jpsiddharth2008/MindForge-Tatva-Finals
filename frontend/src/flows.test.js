import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./chain', async (importActual) => ({ ...(await importActual()), anchorOnChain: vi.fn(), revokeOnChain: vi.fn() }));
vi.mock('./api', async (importActual) => ({
  ...(await importActual()),
  chainPending: vi.fn(), chainConfirmed: vi.fn(), chainFailed: vi.fn(), confirmRevocation: vi.fn(),
}));
import * as chain from './chain';
import * as api from './api';
import { runAnchorFlow, runRevokeFlow, FlowError } from './flows';

const doc = { documentId: 'id1', contentHash: 'c'.repeat(64), sha256: 'b'.repeat(64) };
const tx = (wait = async () => ({})) => ({ hash: `0x${'a'.repeat(64)}`, wait: vi.fn(wait) });
const rejection = () => Object.assign(new Error('user rejected'), { code: 'ACTION_REJECTED' });
const http = (status) => Object.assign(new Error('x'), { response: { status, data: {} } });

beforeEach(() => {
  vi.clearAllMocks();
  api.chainFailed.mockResolvedValue({});
});

describe('runAnchorFlow', () => {
  it('signs, records the transaction, waits, then asks the server to check the chain — in that order', async () => {
    const order = [];
    chain.anchorOnChain.mockImplementation(async () => { order.push('sign'); return tx(async () => { order.push('mined'); }); });
    api.chainPending.mockImplementation(async () => { order.push('pending'); return {}; });
    api.chainConfirmed.mockImplementation(async () => { order.push('confirmed'); return { state: 'issued', document: { status: 'ISSUED' } }; });
    const statuses = [];
    const r = await runAnchorFlow(doc, (s) => statuses.push(s));
    expect(order).toEqual(['sign', 'pending', 'mined', 'confirmed']);
    expect(chain.anchorOnChain).toHaveBeenCalledWith({ contentHash: doc.contentHash, byteHash: doc.sha256 });
    expect(r.state).toBe('issued');
    expect(statuses.length).toBe(4);
  });

  it('passes through a "still pending" answer rather than pretending it is done', async () => {
    chain.anchorOnChain.mockResolvedValue(tx());
    api.chainPending.mockResolvedValue({});
    api.chainConfirmed.mockResolvedValue({ state: 'pending', document: { status: 'BLOCKCHAIN_PENDING' } });
    expect((await runAnchorFlow(doc)).state).toBe('pending');
  });

  it('records a wallet refusal with the server and says so plainly', async () => {
    chain.anchorOnChain.mockRejectedValue(rejection());
    await expect(runAnchorFlow(doc)).rejects.toMatchObject({ name: 'FlowError', rejected: true, message: 'Signature rejected in the wallet.' });
    expect(api.chainFailed).toHaveBeenCalledWith('id1', 'USER_REJECTED');
    expect(api.chainPending).not.toHaveBeenCalled();
  });

  it('still reports a refusal when recording it fails', async () => {
    chain.anchorOnChain.mockRejectedValue(rejection());
    api.chainFailed.mockRejectedValue(http(500));
    await expect(runAnchorFlow(doc)).rejects.toMatchObject({ rejected: true });
  });

  it('shows a wallet problem (no wallet, wrong network) as its own message and records a client error', async () => {
    chain.anchorOnChain.mockRejectedValue(new chain.WalletError('No wallet found. Install a wallet such as MetaMask to sign.'));
    await expect(runAnchorFlow(doc)).rejects.toThrow('No wallet found');
    expect(api.chainFailed).toHaveBeenCalledWith('id1', 'CLIENT_ERROR');
  });

  it('refuses a document with no content hash before touching the wallet', async () => {
    await expect(runAnchorFlow({ ...doc, contentHash: undefined })).rejects.toBeInstanceOf(FlowError);
    expect(chain.anchorOnChain).not.toHaveBeenCalled();
  });

  it('marks a session that ended mid-flow so the app can return to the login page', async () => {
    chain.anchorOnChain.mockResolvedValue(tx());
    api.chainPending.mockRejectedValue(http(401));
    await expect(runAnchorFlow(doc)).rejects.toMatchObject({ unauthorized: true });
  });

  it('turns a failed confirmation into a readable error', async () => {
    chain.anchorOnChain.mockResolvedValue(tx(async () => { throw new Error('replaced'); }));
    api.chainPending.mockResolvedValue({});
    await expect(runAnchorFlow(doc)).rejects.toBeInstanceOf(FlowError);
    expect(api.chainConfirmed).not.toHaveBeenCalled();
  });
});

describe('runRevokeFlow', () => {
  it('sends revoke, waits, then lets the server read the chain', async () => {
    chain.revokeOnChain.mockResolvedValue(tx());
    api.confirmRevocation.mockResolvedValue({ state: 'revoked', document: { status: 'REVOKED' } });
    const r = await runRevokeFlow(doc, 'issued by mistake');
    expect(chain.revokeOnChain).toHaveBeenCalledWith({ contentHash: doc.contentHash, reason: 'issued by mistake' });
    expect(api.confirmRevocation).toHaveBeenCalledWith('id1', `0x${'a'.repeat(64)}`);
    expect(r.state).toBe('revoked');
  });

  it('does not tell the server anything when the wallet refuses', async () => {
    chain.revokeOnChain.mockRejectedValue(rejection());
    await expect(runRevokeFlow(doc, 'x')).rejects.toMatchObject({ rejected: true });
    expect(api.confirmRevocation).not.toHaveBeenCalled();
  });

  it('shows a contract refusal (not the issuer) as the wallet reported it', async () => {
    chain.revokeOnChain.mockRejectedValue(Object.assign(new Error('x'), { shortMessage: 'execution reverted: not issuer' }));
    await expect(runRevokeFlow(doc, 'x')).rejects.toThrow('execution reverted: not issuer');
  });
});
