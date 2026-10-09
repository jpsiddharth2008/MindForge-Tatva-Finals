// End to end with nothing mocked on the chain side: the real backend app, a real MongoDB, and the real CredentialRegistry running on
// Hardhat's EVM. An issuer wallet sends the real anchor() and revoke() transactions; the server decides what to believe by reading
// the chain. (S3 is a stub: it needs a cloud account.)
const { expect } = require("chai");
const { ethers } = require("hardhat");

const backend = (p) => require(`../../backend/${p}`);
const { createApp } = backend("app");
const { createChain } = backend("chain");
const { connectDatabase } = backend("db");
const { createLogger } = backend("logger");
const bcrypt = backend("node_modules/bcryptjs");
const { MongoMemoryServer } = backend("node_modules/mongodb-memory-server");

const PASSWORD = "correct horse battery staple";

describe("issue, anchor, confirm and revoke on a real chain", function () {
  this.timeout(120000);
  let mongod, db, server, url, token, registry, address, admin, issuer, stranger, chain, s3Writes;

  before(async () => {
    [admin, issuer, stranger] = await ethers.getSigners();
    registry = await (await ethers.getContractFactory("CredentialRegistry")).deploy();
    await registry.waitForDeployment();
    address = await registry.getAddress();
    await (await registry.registerIssuer(issuer.address, "Testland Registrar")).wait();

    mongod = await MongoMemoryServer.create();
    db = await connectDatabase(mongod.getUri());
    chain = createChain({ provider: ethers.provider, contractAddress: address });
    s3Writes = [];
    const app = createApp({
      s3: { send: async (c) => { s3Writes.push(c.input.Key); return {}; } },
      bucketName: "e2e", region: "r", logger: createLogger({ logDir: null, silent: true }),
      documents: db.documents, audit: db.audit, chain, contractAddress: address, chainId: 31337,
      presign: async (cmd, ttl) => `https://signed.test/${cmd.input.Key}?X-Amz-Expires=${ttl}`,
      corsOrigins: [],
      auth: { jwtSecret: "x".repeat(40), adminUsername: "registrar", adminPasswordHash: bcrypt.hashSync(PASSWORD, 4) },
    });
    server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
    url = `http://127.0.0.1:${server.address().port}`;
    const login = await fetch(`${url}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "registrar", password: PASSWORD }) });
    token = (await login.json()).token;
  });

  after(async () => {
    if (server) await new Promise((r) => { server.close(r); server.closeAllConnections(); });
    if (db) await db.close();
    if (mongod) await mongod.stop();
  });

  const FIELDS = (n) => ({
    issuer: "Testland Registrar", docType: "Degree Certificate", holder: `Person ${n}`, idNumber: `B2100${n}CS`, issuedOn: "15-06-2026",
    payload: { dob: "12-04-2005", programme: "B.Tech Computer Science", cgpa: "8.7" },
  });
  const api = (method, route, body) => fetch(`${url}${route}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body && JSON.stringify(body) });

  async function upload(n) {
    const form = new FormData();
    form.append("file", new Blob([Buffer.from(`%PDF-1.4 e2e document number ${n}`)], { type: "application/pdf" }), "d.pdf");
    form.append("fields", JSON.stringify(FIELDS(n)));
    const res = await fetch(`${url}/api/anchor`, { method: "POST", body: form, headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).to.equal(200);
    return res.json();
  }

  it("issues a document the registry really holds, and the server marks it ISSUED only after reading the chain", async () => {
    const up = await upload(1);
    expect(up.document.status).to.equal("STORED");
    const { hash, contentHash } = up;
    expect(hash).to.match(/^[a-f0-9]{64}$/);
    expect(contentHash).to.match(/^[a-f0-9]{64}$/);

    const tx = await registry.connect(issuer).anchor("0x" + contentHash, "0x" + hash);
    const receipt = await tx.wait();
    const id = up.document.documentId;
    expect((await (await api("POST", `/api/documents/${id}/chain-pending`, { transactionHash: tx.hash })).json()).document.status).to.equal("BLOCKCHAIN_PENDING");
    const confirmed = await (await api("POST", `/api/documents/${id}/chain-confirmed`, { transactionHash: tx.hash })).json();
    expect(confirmed.state).to.equal("issued");
    expect(confirmed.document.status).to.equal("ISSUED");
    expect(confirmed.document.blockNumber).to.equal(receipt.blockNumber);

    const onChain = await chain.verify(contentHash);
    expect(onChain).to.include({ exists: true, revoked: false, byteHash: hash, issuerName: "Testland Registrar" });
  });

  it("refuses a transaction that anchored something else, even though it succeeded on chain (WRONG_DATA)", async () => {
    const up = await upload(2);
    const other = await upload(3);
    // the issuer anchors document 3's hashes but claims it was document 2's transaction
    const tx = await registry.connect(issuer).anchor("0x" + other.contentHash, "0x" + other.hash);
    await tx.wait();
    const id = up.document.documentId;
    await api("POST", `/api/documents/${id}/chain-pending`, { transactionHash: tx.hash });
    const r = await (await api("POST", `/api/documents/${id}/chain-confirmed`, { transactionHash: tx.hash })).json();
    expect(r.state).to.equal("failed");
    expect(r.document).to.include({ status: "FAILED", failureReason: "WRONG_DATA" });
  });

  it("refuses a transaction that anchored the right content hash with the wrong file hash", async () => {
    const up = await upload(4);
    const tx = await registry.connect(issuer).anchor("0x" + up.contentHash, "0x" + "ee".repeat(32));
    await tx.wait();
    const id = up.document.documentId;
    await api("POST", `/api/documents/${id}/chain-pending`, { transactionHash: tx.hash });
    const r = await (await api("POST", `/api/documents/${id}/chain-confirmed`, { transactionHash: tx.hash })).json();
    expect(r.document.failureReason).to.equal("WRONG_DATA");
  });

  it("a wallet that is not an issuer cannot anchor at all: the contract reverts, so nothing exists for the server to confirm", async () => {
    const up = await upload(5);
    let reverted = false;
    try { await registry.connect(stranger).anchor("0x" + up.contentHash, "0x" + up.hash); } catch { reverted = true; }
    expect(reverted).to.equal(true);
    expect((await chain.verify(up.contentHash)).exists).to.equal(false);
  });

  it("revokes: the issuer's revoke() on chain, then the server mirrors REVOKED with the chain's reason and block time", async () => {
    const up = await upload(6);
    const anchorTx = await registry.connect(issuer).anchor("0x" + up.contentHash, "0x" + up.hash);
    await anchorTx.wait();
    const id = up.document.documentId;
    await api("POST", `/api/documents/${id}/chain-pending`, { transactionHash: anchorTx.hash });
    await api("POST", `/api/documents/${id}/chain-confirmed`, { transactionHash: anchorTx.hash });

    const revokeTx = await registry.connect(issuer).revoke("0x" + up.contentHash, "Degree withdrawn after inquiry");
    const receipt = await revokeTx.wait();
    const block = await ethers.provider.getBlock(receipt.blockNumber);

    const res = await api("POST", `/api/documents/${id}/revoke`, { transactionHash: revokeTx.hash, reason: "ignored: a client cannot choose the reason" });
    const body = await res.json();
    expect(res.status).to.equal(200);
    expect(body.state).to.equal("revoked");
    expect(body.document.status).to.equal("REVOKED");
    expect(body.document.revocationReason).to.equal("Degree withdrawn after inquiry");
    expect(new Date(body.document.revokedAt).getTime()).to.equal(Number(block.timestamp) * 1000);
    expect((await chain.verify(up.contentHash)).revoked).to.equal(true);
  });

  it("a revoke transaction for a different document does not revoke this one", async () => {
    const a = await upload(7);
    const b = await upload(8);
    for (const d of [a, b]) {
      const t = await registry.connect(issuer).anchor("0x" + d.contentHash, "0x" + d.hash);
      await t.wait();
      await api("POST", `/api/documents/${d.document.documentId}/chain-pending`, { transactionHash: t.hash });
      await api("POST", `/api/documents/${d.document.documentId}/chain-confirmed`, { transactionHash: t.hash });
    }
    const revokeB = await registry.connect(issuer).revoke("0x" + b.contentHash, "only b");
    await revokeB.wait();
    const res = await api("POST", `/api/documents/${a.document.documentId}/revoke`, { transactionHash: revokeB.hash });
    expect(res.status).to.equal(409);
    expect((await (await api("GET", `/api/documents/${a.document.documentId}`)).json()).document.status).to.equal("ISSUED");
  });

  it("only the institution that issued a document can revoke it on chain", async () => {
    const up = await upload(9);
    const t = await registry.connect(issuer).anchor("0x" + up.contentHash, "0x" + up.hash);
    await t.wait();
    await (await registry.registerIssuer(stranger.address, "Another Institution")).wait();
    let reverted = false;
    try { await registry.connect(stranger).revoke("0x" + up.contentHash, "not mine to revoke"); } catch { reverted = true; }
    expect(reverted).to.equal(true);
    expect((await chain.verify(up.contentHash)).revoked).to.equal(false);
  });
});
