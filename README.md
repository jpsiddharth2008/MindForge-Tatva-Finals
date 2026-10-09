# MindForge

**Blockchain-anchored document issuance and verification for institutional credentials.**

MindForge lets an authorised institution issue a document whose integrity can later be verified by anyone — without the verifier needing access to the issuing institution's database, credentials, or systems.

The document itself never touches the blockchain. Only a cryptographic fingerprint does.

---

## Table of Contents

- [The Problem](#the-problem)
- [How It Works](#how-it-works)
- [System Architecture](#system-architecture)
- [Where Data Is Stored](#where-data-is-stored)
- [Data Flows](#data-flows)
- [Implementation Status](#implementation-status)
- [Technology Stack](#technology-stack)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [API Reference](#api-reference)
- [Security](#security)
- [Compliance](#compliance)
- [Troubleshooting](#troubleshooting)
- [Roadmap](#roadmap)

---

## The Problem

India already has strong infrastructure for verifying documents the government issued **digitally** — DigiLocker serves over 100 million users, and the National Academic Depository covers degrees.

The gap is everything else:

- The paper certificate in someone's hand
- A scan that arrived over WhatsApp, recompressed three times
- A photograph of a printout handed across a desk
- A deed produced by an office that never digitised

For these, verification is still manual, slow, and dependent on trusting whoever is holding the paper. MindForge targets that gap specifically.

> **What this does not do.** A blockchain match proves a document corresponds to a fingerprint previously recorded by an authorised issuer. It does not prove the real-world facts inside the document were true when issued. Integrity is not veracity.

---

## How It Works

```
Document ──► SHA-256 fingerprint ──► anchored on-chain by an authorised issuer
                                      │
Verifier re-computes the fingerprint ─┘
          │
          └─► match + authorised issuer + not revoked  ⇒  AUTHENTIC
```

Three properties follow from this design:

| Property | Why |
|---|---|
| **Privacy-preserving** | No document content, no personal data on-chain. Only a hash. |
| **Cheap at any size** | Verifying a 10 GB video costs the same as a 1 KB PDF — a hash is 32 bytes either way. |
| **Independently verifiable** | A verifier queries the public chain directly. No API key, no account, no trust in us. |

---

## System Architecture

```mermaid
flowchart TB
    subgraph clients [" "]
        OFF["👤 Issuing Officer"]
        PUB["🌐 Public Verifier"]
    end

    subgraph app ["Application Layer"]
        FE["React + Vite<br/>Issuer portal · Verify portal"]
        API["Node.js + Express<br/>REST API"]
    end

    subgraph svc ["Services"]
        HASH["Hash Engine<br/>SHA-256"]
        AUTH["Auth<br/>JWT · bcrypt"]
    end

    subgraph data ["Persistence"]
        S3[("AWS S3<br/>ap-south-1<br/>document bytes")]
        DB[("MongoDB Atlas<br/>ap-south-1<br/>metadata · audit")]
    end

    subgraph chain ["Trust Layer"]
        RPC["Polygon RPC"]
        SC["CredentialRegistry<br/>Solidity"]
    end

    OFF --> FE
    PUB --> FE
    FE -->|HTTPS| API
    API --> AUTH
    API --> HASH
    API --> S3
    API --> DB
    API --> RPC
    RPC --> SC

    classDef store fill:#1a3a52,stroke:#4a90d9,color:#fff
    classDef trust fill:#3d2a52,stroke:#9d6ad9,color:#fff
    class S3,DB store
    class RPC,SC trust
```

**Design rule:** the backend is the only component holding secrets. The browser never sees a private key, a database URI, or a cloud credential. Public verification requires no wallet and no browser extension.

---

## Where Data Is Stored

Each store holds exactly what it is good at. Nothing is duplicated across them.

```mermaid
flowchart LR
    DOC["📄 degree.pdf"] --> H{"SHA-256"}

    H -->|"the bytes"| S3[("AWS S3<br/>━━━━━━━<br/>Key = contentHash<br/>SSE-AES256<br/>private · presigned")]
    H -->|"facts about it"| DB[("MongoDB Atlas<br/>━━━━━━━━━<br/>hash · s3Key · issuer<br/>txHash · status<br/>audit trail")]
    H -->|"32-byte proof"| BC[("Polygon<br/>━━━━━━<br/>contentHash<br/>issuer address<br/>timestamp · revoked")]

    classDef a fill:#1a3a52,stroke:#4a90d9,color:#fff
    classDef b fill:#1a4a35,stroke:#4ad98a,color:#fff
    classDef c fill:#3d2a52,stroke:#9d6ad9,color:#fff
    class S3 a
    class DB b
    class BC c
```

### Responsibility split

| Store | Holds | Why not elsewhere |
|---|---|---|
| **AWS S3** | The actual PDF / PNG / JPEG | MongoDB caps documents at **16 MB** (BSON limit) and our M0 tier is 512 MB total — roughly 250 scanned PDFs before the cluster is full. S3 is ~10× cheaper per GB, serves downloads directly via presigned URLs so bytes never pass through our server, and gives versioning, lifecycle rules, and object-level encryption. |
| **MongoDB Atlas** | Metadata, status, audit events | S3 is a key-value blob store — it can only answer *"what are the bytes at key X?"* It cannot answer *"which documents did this officer issue?"* or *"has this hash already been anchored?"* without scanning the entire bucket. |
| **Polygon** | 32-byte hash + issuer + timestamp | Storing a 1 MB file on-chain would cost millions in gas, be permanently public, and be impossible to erase. Only the integrity proof needs to be tamper-evident. |

**The hash is the join key.** Because S3 objects are keyed by content hash, all three stores line up automatically:

```
MongoDB record              S3 object           Blockchain
──────────────              ─────────           ──────────
sha256: "a17bc9…"    ────►  Key: "a17bc9…"      records["a17bc9…"]
s3Key:  "a17bc9…"           (the PDF bytes)      { issuer, timestamp, revoked }
issuer: "NITC Registrar"
txHash: "0x8f2e…"
status: "ISSUED"
```

### What is deliberately **not** stored

| Never stored | Where it would have leaked | Why |
|---|---|---|
| Document contents on-chain | Blockchain | Permanent, public, unerasable |
| Personal data on-chain | Blockchain | Conflicts with DPDP Act erasure rights |
| Secrets in MongoDB | Database | Credentials belong in env config only |
| Secrets in `VITE_*` vars | Frontend bundle | Vite inlines these into the browser — publishing them |
| Suspect files during verification | S3 | Verification hashes in memory and discards |
| Request bodies in logs | Log files | That would be document contents |

---

## Data Flows

### Issuance — authorised officer

```mermaid
sequenceDiagram
    autonumber
    actor O as Officer
    participant FE as Frontend
    participant API as Backend
    participant S3 as AWS S3
    participant DB as MongoDB
    participant BC as Polygon

    O->>FE: Select document
    FE->>API: POST /api/anchor (authenticated)
    API->>API: Validate type, magic bytes, size
    API->>API: Compute SHA-256
    API->>DB: Duplicate check on sha256
    DB-->>API: Not found — proceed

    API->>DB: Create record (status: PENDING)
    API->>S3: PutObject (Key = hash, SSE on)
    S3-->>API: Stored
    API->>DB: status: STORED

    API->>BC: anchor(contentHash) — signed server-side
    Note over API,BC: Reverts unless caller is a registered issuer
    BC-->>API: Transaction receipt
    API->>DB: status: ISSUED + txHash + blockNumber

    API-->>FE: Document ID + verification URL + QR
    FE-->>O: Certificate with embedded QR
```

**Failure handling.** If S3 succeeds but the chain write fails, the record is marked `FAILED` and the orphaned object is removed — never a silent half-issued document. Re-submitting the same file returns the existing record rather than anchoring twice.

### Verification — public, no wallet required

```mermaid
sequenceDiagram
    autonumber
    actor V as Verifier
    participant FE as Frontend
    participant API as Backend
    participant BC as Polygon
    participant DB as MongoDB

    V->>FE: Upload suspect document (or scan QR)
    FE->>API: POST /api/verify/file
    API->>API: Compute SHA-256 in memory
    Note over API: File is discarded — never written to S3

    API->>BC: verify(contentHash) — read-only, no gas
    BC-->>API: exists · issuer · timestamp · revoked

    alt Not found
        API-->>FE: ❌ NOT REGISTERED
    else Revoked
        API->>DB: Fetch revocation reason
        API-->>FE: ⚠️ REVOKED
    else Valid
        API->>DB: Resolve issuer display name
        API-->>FE: ✅ AUTHENTIC + issuer + date + explorer link
    end
```

Verification is a **read-only** chain call. It costs no gas, needs no wallet, and requires no account.

---

## Implementation Status

This project is under active development. Status is tracked honestly so that documentation never overstates the code.

| Capability | Status | Tracking |
|---|---|---|
| SHA-256 hashing | ✅ Working | — |
| S3 upload | 🟡 Works; needs content-addressed keys + SSE | #51 |
| Blockchain anchor + read | 🟡 Works; needs server-side signing | #50 |
| Verification flow | 🟡 Works; must stop persisting suspect files | #50 |
| Issuer authorisation | ❌ Not built — any wallet can currently anchor | #47 |
| MongoDB metadata layer | ❌ Not built | #53 |
| Authentication | ❌ Not built | #48 |
| QR verification | ❌ Not built | #58 |
| Revocation | ❌ Not built | #59 |
| Audit trail | ❌ Not built | #61 |
| Contract source in repo | ❌ Missing | #62 |
| Tests | ❌ None | #63 |

**Known limitation.** The current build hashes raw file bytes, so any re-encoding — WhatsApp compression, re-saving a PDF, scanning a printout — changes the hash and produces a false negative. Canonical content hashing (#52) addresses this by hashing normalised extracted fields instead of bytes.

---

## Technology Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite 7, Tailwind CSS 3 |
| Backend | Node.js, Express 5 |
| Database | MongoDB Atlas (AWS `ap-south-1`) |
| Object storage | AWS S3 (`ap-south-1`) |
| Blockchain | Polygon Amoy testnet (chain `80002`) |
| Web3 | Ethers v6 |
| Contract | Solidity |
| Hashing | SHA-256 |

> **Testnet notice.** Amoy is a test network with no economic security, and testnets are periodically deprecated. This is a demonstration deployment — it should not be described as immutable production infrastructure. A production deployment would target Polygon mainnet or a permissioned institutional chain.

---

## Getting Started

### Prerequisites

Node.js LTS · npm · a MongoDB Atlas account · an AWS account with an S3 bucket · a funded Polygon Amoy wallet

### Install

```bash
git clone <repository-url>
cd MindForge
```

**Backend**

```bash
cd backend
npm install
cp .env.example .env     # then fill it in — see below
npm run dev
```

**Frontend** (separate terminal)

```bash
cd frontend
npm install
cp .env.example .env
npm run dev
```

| Service | URL |
|---|---|
| Frontend | http://localhost:5173 |
| API | http://localhost:5000 |
| Health | http://localhost:5000/api/health |

---

## Environment Variables

### `backend/.env` — secrets live here, and only here

```ini
NODE_ENV=development
PORT=5000
FRONTEND_URL=http://localhost:5173

MONGODB_URI=

AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_REGION=ap-south-1
S3_BUCKET_NAME=

POLYGON_RPC_URL=https://rpc-amoy.polygon.technology
POLYGON_CHAIN_ID=80002
CONTRACT_ADDRESS=
PRIVATE_KEY=

JWT_SECRET=
JWT_EXPIRES_IN=1d

MAX_FILE_SIZE_MB=10
```

### `frontend/.env` — public configuration only

```ini
VITE_API_URL=http://localhost:5000/api
VITE_APP_NAME=MindForge
```

> ⚠️ **Vite inlines every `VITE_*` variable into the client bundle.** They are shipped to every visitor's browser and must be treated as public. A `VITE_PRIVATE_KEY` or `VITE_MONGODB_URI` is equivalent to publishing it. Database URIs, cloud secrets, and private keys belong exclusively in `backend/.env`.

Both `.env` files are gitignored. Never commit either.

---

## API Reference

| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/health` | — | Component health |
| `POST` | `/api/auth/login` | — | Officer login |
| `POST` | `/api/auth/logout` | ✅ | End session |
| `GET` | `/api/auth/me` | ✅ | Current user |
| `POST` | `/api/anchor` | ✅ | Issue and anchor a document |
| `GET` | `/api/documents` | ✅ | List issued documents |
| `GET` | `/api/documents/:id` | ✅ | Document detail |
| `POST` | `/api/documents/:id/revoke` | ✅ | Revoke |
| `POST` | `/api/hash` | — | Hash a file, store nothing |
| `POST` | `/api/verify/file` | — | Verify an uploaded file |
| `GET` | `/api/verify/:documentId` | — | Verify by ID (QR target) |

All responses follow a consistent envelope:

```json
{ "success": true, "data": { }, "message": "" }
```

---

## Security

| Control | Approach |
|---|---|
| Secrets | Environment variables only, validated at startup, never committed |
| Authentication | bcrypt password hashing, JWT in HttpOnly cookies |
| Authorisation | Issuance restricted to authorised roles; verification public |
| On-chain authorisation | `anchor()` reverts unless the caller is a registered issuer |
| Transport | HTTPS in production |
| At rest | S3 server-side encryption; Atlas encryption at rest |
| Object access | Presigned URLs with short TTL — never public bucket URLs |
| Upload validation | MIME allowlist, magic-byte check, size cap |
| HTTP hardening | Helmet, environment-driven CORS allowlist, rate limiting, body size limits |
| Error handling | Generic client responses with a correlation ID; detail stays server-side |
| Logging | Structured logs with secret redaction |

### Never logged

Private keys · database URIs · cloud credentials · JWTs · passwords · request bodies on upload routes.

> Logging a full error object from Mongoose or the AWS SDK can print the connection string, credentials included. Log `err.message`, never `err`.

---

## Compliance

This project targets India's **Digital Personal Data Protection Act, 2023**, not GDPR.

| Requirement | Approach |
|---|---|
| Purpose limitation (§4–6) | Verification hashes in memory and discards the file |
| Data minimisation (§8) | Only the hash is anchored; no personal data on-chain |
| Right to erasure (§12) | Document and metadata are deletable; see the note below |
| Security safeguards (§8(5)) | Encryption at rest and in transit, access control, audit logging |
| Data localisation | All storage in AWS `ap-south-1` (Mumbai) |

**On erasure and the blockchain.** The on-chain hash cannot be deleted. Our position is that deleting the document and all metadata leaves a salted hash with no recoverable link to an individual. Salting matters: an unsalted hash of a known document format is vulnerable to confirmation attacks, where an adversary holding a candidate document can verify their guess. We do not claim to have "solved" the blockchain-privacy tension — we claim a specific, stated mitigation.

---

## Troubleshooting

**`querySrv ECONNREFUSED` connecting to MongoDB**
The network is blocking DNS SRV lookups — common on campus Wi-Fi. In Atlas → Connect → Drivers, select *Node.js 6.7 or later* and toggle **off** the SRV switch to obtain the long-form `mongodb://` multi-host string.

**`MODULE_NOT_FOUND` running the server**
Run from the `backend/` directory, not the repository root, and install dependencies first.

**Blockchain initialisation fails**
Check `POLYGON_RPC_URL` is reachable, that the connected chain ID matches `POLYGON_CHAIN_ID`, that `CONTRACT_ADDRESS` has deployed bytecode on that chain, and that the signer wallet holds enough POL for gas.

**Frontend cannot reach the backend**
Confirm `VITE_API_URL` and that the backend CORS allowlist includes the frontend origin. Restart Vite after changing `.env` — variables are read at build time.

**Upload rejected**
Check the file type is in the allowlist and the size is under `MAX_FILE_SIZE_MB`.

---

## Roadmap

**Near term**
Canonical content hashing so verification survives re-encoding · issuer registry with on-chain authorisation · revocation · QR verification bound to document content

**Later**
Institutional SSO · batch issuance · W3C Verifiable Credentials and DID interoperability · selective disclosure via zero-knowledge proofs · mobile verification app

---

## License

No license file is currently present. Add one before treating this project as open source.
