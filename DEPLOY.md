# Deploying MindForge

Local development is one command — `./dev.sh`. This document is about putting
it on the internet, which is a different problem, mostly because of the chain.

## Read this first

**Deploy for the submission link. Demo from `./dev.sh`.**

The hosted version is worth having so judges can try it afterwards. It is the
wrong thing to present live:

| | `./dev.sh` | hosted |
|---|---|---|
| Block time | instant | ~12 s on Sepolia |
| Survives venue wifi dying | yes | no |
| Cold start | none | ~50 s on a free tier |
| RPC rate limits | none | yes, on public endpoints |

OCR already runs locally (`ocr-data/eng.traineddata` is committed) and the chain
and database can too, so the local stack works with the network unplugged. Do
not trade that away for a URL.

## What has to change, and the one thing that blocks everything

The Hardhat chain **cannot be hosted**. It keeps its state in memory and loses
every anchored document when it stops. A public deployment requires the contract
on a public testnet.

So the critical path is: **#92 (wallets) → #94 (Sepolia + faucet) → deploy the
contract → everything else**. Nothing below works until the contract has an
address on Sepolia.

```bash
cd blockchain
npm run deploy:sepolia          # needs PRIVATE_KEY in blockchain/.env and a funded account
# address lands in blockchain/deployments/sepolia.json
ISSUERS="0xYourIssuer=NIT Calicut — Registrar" \
  npx hardhat run scripts/register-issuer.js --network sepolia
```

Keep one wallet **off** the issuer list. Anchoring from it must revert with
`NotAuthorisedIssuer` — that is the demonstration that a green tick means "an
authorised institution issued this", not "somebody registered these bytes".

## Pieces

| Piece | Where | Config |
|---|---|---|
| API | Render | `render.yaml` |
| Frontend | Vercel | `frontend/vercel.json` |
| Database | MongoDB Atlas | Network Access `0.0.0.0/0` |
| Files | AWS S3 | existing bucket + CORS |
| Contract | Ethereum Sepolia (11155111) | `npm run deploy:sepolia` |

### 1. MongoDB Atlas

Network Access → **`0.0.0.0/0`**. Not laziness: Render's egress IPs are not fixed,
so an allowlist cannot be written. The database user's password is still required.
Use a user scoped to this one database, not an admin.

### 2. S3

The IAM user needs only `s3:PutObject` and `s3:GetObject` on
`arn:aws:s3:::<bucket>/*`. It does **not** need bucket-admin rights —
`npm run check-bucket` will report `AccessDenied` on three configuration audits
and that is expected and fine; the app never calls those.

Add a CORS rule allowing your Vercel origin if the browser fetches signed URLs
directly.

### 3. API on Render

Blueprint → point at this repo → `render.yaml` is picked up. Fill every
`sync: false` variable in the dashboard.

`CHAIN_ID` **must** be `11155111` and match `RPC_URL`. `createChain` pins the
network and asserts it, and `/api/health` additionally checks `eth_getCode` is
non-empty at `CONTRACT_ADDRESS`. A mismatch fails every chain call — this is the
exact bug that produced a contract declared on Amoy while living on Sepolia
(`blockchain/README.md`).

There is **no `PRIVATE_KEY`**. `chain.js` is read-only and the officer signs in
their own wallet. If you find yourself adding one, something has gone wrong.

### 4. Frontend on Vercel

Root directory `frontend`. Environment variables:

```
VITE_API_URL=https://<your-api>.onrender.com
VITE_CHAIN_ID=11155111
VITE_CONTRACT_ADDRESS=0x…
```

Vite inlines `VITE_*` at **build** time, so changing one requires a redeploy, not
a restart.

### 5. Close the loop

Set `CORS_ORIGINS` on Render to the exact Vercel origin —
`https://mindforge.vercel.app`, no trailing slash. `security.js` matches exactly;
a wildcard or a stray slash blocks every browser call, and it surfaces as an
opaque network error rather than an obvious CORS message.

## Things that will bite

**Mixed content.** An HTTPS page cannot call an HTTP API; the browser blocks it
silently. Both halves must be HTTPS. Camera scanning also requires a secure
context.

**Memory.** Tesseract's language model is 5 MB, sharp decodes full-resolution
images, uploads reach 10 MB. 512 MB is not enough. `render.yaml` specifies the
2 GB plan for this reason.

**Cold starts.** On a spun-down instance the first request takes ~50 s. If you
must use a free tier, hit `/api/health` a minute before anyone opens the link.

**Sepolia confirmation time.** ~12 s per block, and the UI waits for the
transaction. Say so while demonstrating rather than letting it look hung.

## Verify the deployment

```bash
curl -s https://<your-api>.onrender.com/api/health | jq
```

Every component should read `ok`:

```json
{"app":"ok","s3_config":"ok","mongodb":"ok","polygon_rpc":"ok","contract":"ok"}
```

`contract: ok` means there is actually bytecode at `CONTRACT_ADDRESS` on the
chain `CHAIN_ID` names. If it is not ok, re-read step 3 before anything else —
everything downstream depends on it.

Then issue one document end to end. That single action exercises OCR, Mongo, S3
and the chain together, and is the only check that proves the deployment works.
