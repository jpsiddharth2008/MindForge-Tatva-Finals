import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ErrorBoundary from './ErrorBoundary';
import VerdictCard, { STYLES } from './VerdictCard';
import QrScanner from './QrScanner';
import { StatusBadge } from './Layout';

afterEach(() => vi.restoreAllMocks());

describe('ErrorBoundary', () => {
  const Bomb = () => { throw new Error('secret internal detail'); };

  it('shows a recovery screen instead of a blank page, and does not leak the error text', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<ErrorBoundary><Bomb /></ErrorBoundary>);
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong');
    expect(document.body.textContent).not.toContain('secret internal detail');
  });

  it('can try again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let explode = true;
    const Maybe = () => { if (explode) throw new Error('x'); return <p>recovered</p>; };
    render(<ErrorBoundary><Maybe /></ErrorBoundary>);
    explode = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('recovered')).toBeInTheDocument();
  });
});

describe('VerdictCard', () => {
  const base = { confidence: 'HIGH', reason: 'because' };

  it('looks different for every verdict and says what it is in words, not only colour', () => {
    const seen = new Set();
    for (const verdict of Object.keys(STYLES)) {
      const { container, unmount } = render(<VerdictCard report={{ ...base, verdict }} />);
      expect(container.querySelector(`[data-verdict="${verdict}"]`)).toHaveTextContent(STYLES[verdict].title);
      seen.add(STYLES[verdict].title);
      unmount();
    }
    expect(seen.size).toBe(Object.keys(STYLES).length);
    expect(Object.keys(STYLES)).toHaveLength(8);
  });

  it('treats an unknown verdict as inconclusive, never as authentic', () => {
    render(<VerdictCard report={{ ...base, verdict: 'SOMETHING_NEW' }} />);
    expect(screen.getByRole('status')).toHaveTextContent('Inconclusive');
  });

  it('renders nothing without a report', () => {
    const { container } = render(<VerdictCard report={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the revocation reason and time', () => {
    render(<VerdictCard report={{ ...base, verdict: 'REVOKED', revocation: { reason: 'issued in error', at: '2026-06-15T10:00:00Z' } }} />);
    expect(screen.getByTestId('revocation')).toHaveTextContent('issued in error');
  });

  it('says "not shown publicly" for a withheld registered value, and shows it when it was sent', () => {
    const diffs = (d) => ({ ...base, verdict: 'TAMPERED_CONTENT', tiers: { content: { fieldDiffs: [d] } } });
    const { unmount } = render(<VerdictCard report={diffs({ field: 'holder', anchored: null, anchoredWithheld: true, presented: 'MALLORY' })} />);
    expect(screen.getByTestId('anchored-holder')).toHaveTextContent('not shown publicly');
    expect(screen.getByText('MALLORY')).toBeInTheDocument();
    unmount();
    render(<VerdictCard report={diffs({ field: 'holder', anchored: 'ASHA', presented: 'MALLORY' })} />);
    expect(screen.getByTestId('anchored-holder')).toHaveTextContent('ASHA');
  });

  it('boxes the suspect tile in the appearance map', () => {
    const regions = [[0, 0, 0, 0], [0, 40, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    const { container } = render(<VerdictCard report={{ ...base, verdict: 'TAMPERED_VISUAL', tiers: { visual: { regions, divergedCells: [[1, 1]], changedRegions: ['photo'] } } }} />);
    expect(container.querySelector('[data-cell="1,1"]').dataset.flagged).toBe('true');
    expect(container.querySelectorAll('[data-flagged="true"]')).toHaveLength(1);
  });

  it('says which part of the picture could not be checked, so "no change found" is not read as "checked everywhere"', () => {
    const regions = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    const { rerender } = render(<VerdictCard report={{ ...base, verdict: 'AUTHENTIC_COPY', tiers: { visual: { regions, divergedCells: [], changedRegions: [], unreliableRegions: ['photo'] } } }} />);
    expect(screen.getByTestId('unchecked-regions')).toHaveTextContent('photo area of this document is too plain to compare reliably, so it was not checked');
    rerender(<VerdictCard report={{ ...base, verdict: 'AUTHENTIC_COPY', tiers: { visual: { regions, divergedCells: [], changedRegions: [], unreliableRegions: [] } } }} />);
    expect(screen.queryByTestId('unchecked-regions')).toBeNull();
  });

  it('shows the appearance map only where it matters: not for a byte-identical file or an altered field', () => {
    const tiers = { visual: { regions: [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], divergedCells: [], changedRegions: [], unreliableRegions: ['photo'] } };
    for (const verdict of ['AUTHENTIC_ORIGINAL', 'TAMPERED_CONTENT', 'NOT_REGISTERED', 'REVOKED', 'QR_MISMATCH']) {
      const { container, unmount } = render(<VerdictCard report={{ ...base, verdict, tiers }} />);
      expect(container.querySelector('[data-cell]'), verdict).toBeNull();
      expect(screen.queryByTestId('unchecked-regions'), verdict).toBeNull();
      unmount();
    }
    for (const verdict of ['AUTHENTIC_COPY', 'TAMPERED_VISUAL', 'INCONCLUSIVE']) {
      const { container, unmount } = render(<VerdictCard report={{ ...base, verdict, tiers }} />);
      expect(container.querySelector('[data-cell]'), verdict).not.toBeNull();
      unmount();
    }
  });

  it('warns when the answer was not confirmed on the blockchain, and reports a QR mismatch', () => {
    render(<VerdictCard report={{ ...base, verdict: 'AUTHENTIC_COPY', chainChecked: false, qr: { checked: true, matches: false } }} />);
    expect(screen.getByTestId('not-chain-checked')).toBeInTheDocument();
    expect(screen.getByTestId('qr-status')).toHaveTextContent('does not match');
  });

  it('does not make a link out of a malformed transaction hash', () => {
    render(<VerdictCard report={{ ...base, verdict: 'AUTHENTIC_ORIGINAL', anchor: { issuer: 'X', txHash: 'javascript:alert(1)' } }} />);
    expect(screen.queryByRole('link')).toBeNull();
  });
});

describe('StatusBadge', () => {
  it('uses readable words', () => {
    render(<><StatusBadge status="BLOCKCHAIN_PENDING" /><StatusBadge status="ISSUED" /><StatusBadge status="WHATEVER" /></>);
    expect(screen.getByText('Awaiting chain')).toBeInTheDocument();
    expect(screen.getByText('Issued')).toBeInTheDocument();
    expect(screen.getByText('Whatever')).toBeInTheDocument();
  });
});

describe('QrScanner', () => {
  const fakeScanner = (impl) => class { constructor() { this.impl = impl; } scanFile(f) { return this.impl.scanFile(f); } start(...a) { return this.impl.start(...a); } stop() { return Promise.resolve(); } clear() {} };

  it('reports the text read from a photo', async () => {
    const onResult = vi.fn();
    const Scanner = fakeScanner({ scanFile: async () => '{"v":1}' });
    const { container } = render(<QrScanner onResult={onResult} Scanner={Scanner} />);
    await userEvent.upload(container.querySelector('input[type=file]'), new File(['x'], 'qr.png', { type: 'image/png' }));
    expect(onResult).toHaveBeenCalledWith('{"v":1}');
    expect(await screen.findByText('QR code read.')).toBeInTheDocument();
  });

  it('says what to do when no code can be read, and reports nothing', async () => {
    const onResult = vi.fn();
    const Scanner = fakeScanner({ scanFile: async () => { throw new Error('no code'); } });
    const { container } = render(<QrScanner onResult={onResult} Scanner={Scanner} />);
    await userEvent.upload(container.querySelector('input[type=file]'), new File(['x'], 'qr.png', { type: 'image/png' }));
    expect(await screen.findByText(/No QR code could be read/)).toBeInTheDocument();
    expect(onResult).not.toHaveBeenCalled();
  });

  it('explains a camera that cannot be started', async () => {
    const Scanner = fakeScanner({ start: async () => { throw new Error('denied'); } });
    render(<QrScanner onResult={() => {}} Scanner={Scanner} />);
    await userEvent.click(screen.getByRole('button', { name: 'Scan with the camera' }));
    expect(await screen.findByText(/camera could not be started/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Scan with the camera' })).toBeInTheDocument();   // not stuck in "scanning"
  });
});
