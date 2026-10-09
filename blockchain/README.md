# MindForge · Blockchain

`CredentialRegistry` — the trust anchor. Records document fingerprints, gated on
an issuer allowlist, with per-document revocation.

## Why issuer gating matters

The previously deployed contract exposed `addDocument(string)` with no access
control. Any wallet could anchor any hash, so a successful verification proved
only *"somebody registered these bytes"* — not *"an authorised institution issued
this document"*. That distinction is the entire product.

`anchor()` now reverts with `NotAuthorisedIssuer` unless the caller is on the
allowlist.

## What is stored on-chain

| Field | Tier | Why |
|---|---|---|
| `contentHash` | 2 | Primary key. Canonical hash of extracted fields — survives scanning, photographing and recompression. |
| `byteHash` | 1 | Lets a verifier holding the pristine original be told so explicitly. |
| `issuer`, `issuedAt`, `revoked` | — | Provenance and lifecycle. |

The **perceptual hash (Tier 3) is deliberately not stored here.** It is a
similarity score compared against a tunable threshold; anchoring a fuzzy value in
an immutable ledger would imply a certainty it does not carry. It lives in
MongoDB.

Revocation reasons are emitted as events rather than stored — events are far
cheaper and remain permanently retrievable.

## Setup

```bash
cd blockchain
npm install
cp .env.example .env     # add PRIVATE_KEY
npm run build
npm test
```

## Deploy

Develop against a local node first — instant, free, no faucet dependency:

```bash
npx hardhat node                 # terminal 1
npm run deploy:local             # terminal 2
```

Then the testnet:

```bash
npm run deploy:amoy
```

`deploy.js` writes `deployments/<network>.json` and `abi/CredentialRegistry.json`,
then attempts source verification on the explorer. It prints the values to copy
into `backend/.env`.

## Register issuers

Edit the `ISSUERS` array in `scripts/register-issuer.js`, then:

```bash
npx hardhat run scripts/register-issuer.js --network amoy
```

> **Keep one wallet off the allowlist.** Anchoring from it must revert. That
> failing transaction is the on-stage proof that authorisation is real.

## Chain note

The previous contract `0x1477EE05dceBdb88Fbc49d6b0C2c5F5De7051ea3` is deployed on
**Ethereum Sepolia**, not Polygon Amoy — confirmed via `eth_getCode` against both
networks. Any config pointing that address at chain 80002 will fail every call.
This package deploys fresh, so the address and chain ID always agree.

## API

| Function | Access | Purpose |
|---|---|---|
| `registerIssuer(address,string)` | admin | Add an institution |
| `removeIssuer(address)` | admin | Revoke issuing authority (existing docs stay valid) |
| `transferAdmin` / `acceptAdmin` | admin / pending | Two-step handover — cannot lock the contract |
| `anchor(bytes32,bytes32)` | issuer | Anchor contentHash + byteHash |
| `revoke(bytes32,string)` | issuing authority only | Revoke one document |
| `verify(bytes32)` | public view | Resilient path — by content hash |
| `verifyByByteHash(bytes32)` | public view | Strict path — exact original |
| `isIssuer` / `isAnchored` | public view | Helpers |

## Which chain is the old contract on? (answered)

The contract the first prototype used, `0x1477EE05dceBdb88Fbc49d6b0C2c5F5De7051ea3`, is on **Ethereum Sepolia (chain 11155111)**, not
Polygon Amoy. Checked on 2026-10-10 with a read-only `eth_getCode`: 2,611 bytes of code on Sepolia, none on Amoy (chain 80002). Its code
contains the selectors for `addDocument(string)` and `verifyDocument(string)` and **none** of `anchor`, `revoke`, `registerIssuer` or
`verify(bytes32)`. So it is the old, ungated contract, and nothing in this package has been deployed anywhere yet.

## Not done here (needs a funded key and an explorer API key)

- Deploying `CredentialRegistry` to a public network and verifying its source on the explorer. `npm run deploy:amoy` does both when
  `PRIVATE_KEY` and `POLYGONSCAN_API_KEY` are set; link the verified source here once it has run.
- Registering real issuers: `scripts/register-issuer.js`.

## Install note

`@nomicfoundation/hardhat-toolbox` needs its peer packages installed. They are declared in `package.json` explicitly, so
`npm install` works even where `legacy-peer-deps=true` is set globally (which skips them).
