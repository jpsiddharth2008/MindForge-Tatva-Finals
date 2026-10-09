import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { explorerTxUrl } from './config';

const TX = `0x${'ab'.repeat(32)}`;

describe('explorerTxUrl', () => {
  it('links to the right explorer for known networks', () => {
    expect(explorerTxUrl(137, TX)).toBe(`https://polygonscan.com/tx/${TX}`);
    expect(explorerTxUrl('80002', TX)).toBe(`https://amoy.polygonscan.com/tx/${TX}`);
  });
  it('gives no link for a local chain, an unknown chain, or a malformed hash', () => {
    expect(explorerTxUrl(31337, TX)).toBeNull();
    expect(explorerTxUrl(undefined, TX)).toBeNull();
    expect(explorerTxUrl(137, '0x123')).toBeNull();
    expect(explorerTxUrl(137, undefined)).toBeNull();
    expect(explorerTxUrl(137, `${TX}"><script>`)).toBeNull();
  });
});

// Settings come from config.js and the environment, never from a literal in a component.
describe('no hardcoded deployment details', () => {
  const root = join(__dirname);
  const files = [];
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { if (name !== 'abi' && name !== 'test') walk(p); } else if (/\.(jsx?|css)$/.test(name) && !/\.test\./.test(name)) files.push(p);
    }
  })(root);

  it('finds the source files', () => expect(files.length).toBeGreaterThan(10));

  it('has no contract address or private-key-shaped value in the source', () => {
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      expect(text, relative(root, f)).not.toMatch(/0x[a-fA-F0-9]{40}\b/);
      expect(text, relative(root, f)).not.toMatch(/0x[a-fA-F0-9]{64}\b/);
      expect(text, relative(root, f)).not.toMatch(/nvapi-|AKIA[A-Z0-9]{12}|-----BEGIN/);
    }
  });

  it('names the API origin in exactly one place', () => {
    const holders = files.filter((f) => /localhost:\d+/.test(readFileSync(f, 'utf8'))).map((f) => relative(root, f));
    expect(holders).toEqual(['config.js']);
  });

  it('keeps the officer session out of browser storage', () => {
    for (const f of files) expect(readFileSync(f, 'utf8'), relative(root, f)).not.toMatch(/(localStorage|sessionStorage)\.|document\.cookie/);
  });
});
