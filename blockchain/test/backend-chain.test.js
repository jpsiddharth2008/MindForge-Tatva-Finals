// The backend's chain layer (backend/chain.js) against a REAL EVM running the REAL contract: not a mock.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { createChain, toBytes32, fromBytes32 } = require("../../backend/chain");

const HASH = (n) => n.toString(16).padStart(64, "0");        // 64 lowercase hex characters, no prefix

describe("backend/chain.js against the real contract", () => {
  let registry, admin, issuer, stranger, chain, address;

  beforeEach(async () => {
    [admin, issuer, stranger] = await ethers.getSigners();
    registry = await (await ethers.getContractFactory("CredentialRegistry")).deploy();
    await registry.waitForDeployment();
    address = await registry.getAddress();
    await (await registry.registerIssuer(issuer.address, "Testland Registrar")).wait();
    chain = createChain({ provider: ethers.provider, contractAddress: address });
  });

  const anchor = async (c, b, signer = issuer) => {
    const tx = await registry.connect(signer).anchor("0x" + c, "0x" + b);
    await tx.wait();
    return tx.hash;
  };

  describe("receipts", () => {
    it("reports a mined anchoring transaction as a success addressed to the contract", async () => {
      const hash = await anchor(HASH(1), HASH(2));
      const r = await chain.getReceipt(hash);
      expect(r.state).to.equal("success");
      expect(r.to.toLowerCase()).to.equal(address.toLowerCase());
      expect(r.blockNumber).to.be.greaterThan(0);
    });

    it("reports an unknown transaction as not found, not as an error", async () => {
      expect(await chain.getReceipt("0x" + "ab".repeat(32))).to.deep.equal({ state: "not_found" });
    });
  });

  describe("what a transaction actually asked for (calldata)", () => {
    it("decodes anchor(contentHash, byteHash) and who sent it", async () => {
      const hash = await anchor(HASH(11), HASH(22));
      const call = await chain.getAnchorCall(hash);
      expect(call.contentHash).to.equal(HASH(11));
      expect(call.byteHash).to.equal(HASH(22));
      expect(call.from.toLowerCase()).to.equal(issuer.address.toLowerCase());
    });

    it("returns null for any transaction that is not an anchor call", async () => {
      const other = await registry.registerIssuer(stranger.address, "Someone Else");
      await other.wait();
      expect(await chain.getAnchorCall(other.hash)).to.equal(null);
      const plain = await admin.sendTransaction({ to: stranger.address, value: 1n });
      await plain.wait();
      expect(await chain.getAnchorCall(plain.hash)).to.equal(null);
      expect(await chain.getAnchorCall("0x" + "cd".repeat(32))).to.equal(null);
    });

    it("decodes revoke(contentHash, reason) and keeps the reason exactly", async () => {
      await anchor(HASH(5), HASH(6));
      const tx = await registry.connect(issuer).revoke("0x" + HASH(5), "Issued in error: wrong programme");
      await tx.wait();
      const call = await chain.getRevokeCall(tx.hash);
      expect(call).to.include({ contentHash: HASH(5), reason: "Issued in error: wrong programme" });
      expect(await chain.getAnchorCall(tx.hash)).to.equal(null);
      expect(await chain.getRevokeCall((await anchor(HASH(7), HASH(8))))).to.equal(null);
    });
  });

  describe("the registry's own record", () => {
    it("verify(): registered, issuer name, timestamp, not revoked, byte hash", async () => {
      await anchor(HASH(31), HASH(32));
      const v = await chain.verify(HASH(31));
      expect(v.exists).to.equal(true);
      expect(v.issuer.toLowerCase()).to.equal(issuer.address.toLowerCase());
      expect(v.issuerName).to.equal("Testland Registrar");
      expect(v.revoked).to.equal(false);
      expect(v.byteHash).to.equal(HASH(32));
      expect(v.issuedAt).to.be.greaterThan(1_700_000_000);
    });

    it("verify(): an unanchored hash does not exist", async () => {
      const v = await chain.verify(HASH(99));
      expect(v.exists).to.equal(false);
      expect(v.revoked).to.equal(false);
    });

    it("verifyByByteHash(): an untouched original resolves to its content hash; an unknown file does not", async () => {
      await anchor(HASH(41), HASH(42));
      const hit = await chain.verifyByByteHash(HASH(42));
      expect(hit).to.include({ exists: true, contentHash: HASH(41), revoked: false });
      const miss = await chain.verifyByByteHash(HASH(43));
      expect(miss).to.include({ exists: false, contentHash: null });
    });

    it("isIssuer() follows the allowlist", async () => {
      expect(await chain.isIssuer(issuer.address)).to.equal(true);
      expect(await chain.isIssuer(stranger.address)).to.equal(false);
      await (await registry.removeIssuer(issuer.address)).wait();
      expect(await chain.isIssuer(issuer.address)).to.equal(false);
    });
  });

  describe("revocation: reason and time come from the event, because the contract stores neither", () => {
    it("is null before revocation and for a document that never existed", async () => {
      await anchor(HASH(51), HASH(52));
      expect(await chain.getRevocation(HASH(51))).to.equal(null);
      expect(await chain.getRevocation(HASH(98))).to.equal(null);
    });

    it("after revoke(): verify() says revoked, and getRevocation() has the reason, the revoker, the transaction and the block time", async () => {
      await anchor(HASH(53), HASH(54));
      const tx = await registry.connect(issuer).revoke("0x" + HASH(53), "Degree withdrawn");
      const receipt = await tx.wait();
      expect((await chain.verify(HASH(53))).revoked).to.equal(true);
      const rev = await chain.getRevocation(HASH(53));
      expect(rev.reason).to.equal("Degree withdrawn");
      expect(rev.by.toLowerCase()).to.equal(issuer.address.toLowerCase());
      expect(rev.txHash).to.equal(tx.hash);
      expect(rev.blockNumber).to.equal(receipt.blockNumber);
      const block = await ethers.provider.getBlock(receipt.blockNumber);
      expect(rev.at.getTime()).to.equal(Number(block.timestamp) * 1000);
    });

    it("does not confuse two documents' revocations", async () => {
      await anchor(HASH(61), HASH(62));
      await anchor(HASH(63), HASH(64));
      await (await registry.connect(issuer).revoke("0x" + HASH(63), "second only")).wait();
      expect(await chain.getRevocation(HASH(61))).to.equal(null);
      expect((await chain.getRevocation(HASH(63))).reason).to.equal("second only");
    });
  });

  describe("inputs are never guessed", () => {
    it("refuses anything that is not exactly 64 lowercase hex characters", async () => {
      for (const bad of ["0x" + HASH(1), HASH(0xabcdef).toUpperCase(), HASH(1).slice(1), HASH(1) + "0", "", undefined, null, 12]) {
        expect(() => toBytes32(bad), String(bad)).to.throw(/64-character/);
        let rejected = false;
        try { await chain.verify(bad); } catch { rejected = true; }
        expect(rejected, `verify(${bad})`).to.equal(true);
      }
      expect(toBytes32(HASH(1))).to.equal("0x" + HASH(1));
      expect(fromBytes32("0x" + HASH(0xabcdef).toUpperCase())).to.equal(HASH(0xabcdef));
    });

    it("says so when no contract address is configured, instead of querying nothing", async () => {
      const bare = createChain({ provider: ethers.provider });
      let message = "";
      try { await bare.verify(HASH(1)); } catch (e) { message = e.message; }
      expect(message).to.match(/no contract address/);
      expect(() => createChain({})).to.throw(/rpcUrl or a provider/);
    });
  });
});
