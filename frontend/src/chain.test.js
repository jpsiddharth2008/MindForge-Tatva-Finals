import { describe, it, expect, vi } from 'vitest';

vi.mock('./config', () => ({ CONTRACT_ADDRESS: '0x5FbDB2315678afecb367f032d93F642f64180aa3', CHAIN_ID: 31337, API_URL: 'http://x' }));
import { toBytes32, isUserRejection, anchorOnChain, revokeOnChain, WalletError } from './chain';

// A minimal EIP-1193 wallet that answers only what the checks ask for.
const wallet = (chainId) => ({
  request: vi.fn(async ({ method }) => {
    if (method === 'eth_chainId') return `0x${chainId.toString(16)}`;
    if (method === 'net_version') return String(chainId);
    if (method === 'eth_accounts' || method === 'eth_requestAccounts') return ['0x70997970C51812dc3A010C7d01b50e0d17dc79C8'];
    throw new Error(`unexpected ${method}`);
  }),
});

describe('toBytes32', () => {
  it('accepts exactly 64 lowercase hex characters', () => {
    expect(toBytes32('a'.repeat(64))).toBe(`0x${'a'.repeat(64)}`);
  });
  it.each([undefined, null, '', 'abc', 'A'.repeat(64), 'g'.repeat(64), `0x${'a'.repeat(64)}`, 'a'.repeat(65), 12345])('refuses %j', (v) => {
    expect(() => toBytes32(v)).toThrow(WalletError);
  });
});

describe('isUserRejection', () => {
  it('recognises the ways wallets say no', () => {
    expect(isUserRejection({ code: 'ACTION_REJECTED' })).toBe(true);
    expect(isUserRejection({ code: 4001 })).toBe(true);
    expect(isUserRejection({ info: { error: { code: 4001 } } })).toBe(true);
    expect(isUserRejection(new Error('network down'))).toBe(false);
    expect(isUserRejection(undefined)).toBe(false);
  });
});

describe('wallet checks', () => {
  it('says so when there is no wallet', async () => {
    await expect(anchorOnChain({ contentHash: 'a'.repeat(64), byteHash: 'b'.repeat(64) }, undefined)).rejects.toThrow(/No wallet found/);
  });

  it('refuses a wallet on the wrong network, naming both', async () => {
    await expect(anchorOnChain({ contentHash: 'a'.repeat(64), byteHash: 'b'.repeat(64) }, wallet(1)))
      .rejects.toThrow(/connected to network 1\. Switch it to network 31337/);
  });

  it('refuses a malformed fingerprint before asking the wallet to sign anything', async () => {
    const w = wallet(31337);
    await expect(anchorOnChain({ contentHash: 'not-a-hash', byteHash: 'b'.repeat(64) }, w)).rejects.toThrow(/fingerprint/);
    expect(w.request.mock.calls.map(([a]) => a.method)).not.toContain('eth_sendTransaction');
  });

  it('refuses a revocation without a reason', async () => {
    await expect(revokeOnChain({ contentHash: 'a'.repeat(64), reason: '   ' }, wallet(31337))).rejects.toThrow(/reason/);
  });
});
