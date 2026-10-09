const { expect } = require("chai");
const { ethers } = require("hardhat");

const h = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));
const CONTENT = h("content:degree:rohit");
const BYTES   = h("bytes:degree.pdf");

describe("CredentialRegistry", function () {
  let registry, admin, issuer, otherIssuer, outsider;

  beforeEach(async function () {
    [admin, issuer, otherIssuer, outsider] = await ethers.getSigners();
    registry = await (await ethers.getContractFactory("CredentialRegistry")).deploy();
    await registry.waitForDeployment();
    await registry.registerIssuer(issuer.address, "NIT Calicut — Registrar");
    await registry.registerIssuer(otherIssuer.address, "Sub-Registrar Kozhikode");
  });

  describe("issuer authority", function () {
    it("lets a registered issuer anchor", async function () {
      await expect(registry.connect(issuer).anchor(CONTENT, BYTES))
        .to.emit(registry, "Anchored");
      expect(await registry.isAnchored(CONTENT)).to.equal(true);
    });

    // The core security property: without this the green checkmark is meaningless.
    it("rejects anchoring from an unregistered wallet", async function () {
      await expect(registry.connect(outsider).anchor(CONTENT, BYTES))
        .to.be.revertedWithCustomError(registry, "NotAuthorisedIssuer");
    });

    it("rejects a removed issuer", async function () {
      await registry.removeIssuer(issuer.address);
      await expect(registry.connect(issuer).anchor(CONTENT, BYTES))
        .to.be.revertedWithCustomError(registry, "NotAuthorisedIssuer");
    });

    it("only admin may register issuers", async function () {
      await expect(registry.connect(outsider).registerIssuer(outsider.address, "Fake University"))
        .to.be.revertedWithCustomError(registry, "NotAdmin");
    });

    it("keeps documents valid after their issuer is removed", async function () {
      await registry.connect(issuer).anchor(CONTENT, BYTES);
      await registry.removeIssuer(issuer.address);
      const [exists, , , , revoked] = await registry.verify(CONTENT);
      expect(exists).to.equal(true);
      expect(revoked).to.equal(false);
    });
  });

  describe("anchoring", function () {
    it("rejects duplicates", async function () {
      await registry.connect(issuer).anchor(CONTENT, BYTES);
      await expect(registry.connect(issuer).anchor(CONTENT, BYTES))
        .to.be.revertedWithCustomError(registry, "AlreadyAnchored");
    });

    it("rejects zero hashes", async function () {
      await expect(registry.connect(issuer).anchor(ethers.ZeroHash, BYTES))
        .to.be.revertedWithCustomError(registry, "ZeroHash");
    });

    it("records issuer, timestamp and byte hash", async function () {
      await registry.connect(issuer).anchor(CONTENT, BYTES);
      const [exists, who, name, issuedAt, revoked, byteHash] = await registry.verify(CONTENT);
      expect(exists).to.equal(true);
      expect(who).to.equal(issuer.address);
      expect(name).to.equal("NIT Calicut — Registrar");
      expect(issuedAt).to.be.greaterThan(0);
      expect(revoked).to.equal(false);
      expect(byteHash).to.equal(BYTES);
    });

    it("resolves by byte hash for an untouched original", async function () {
      await registry.connect(issuer).anchor(CONTENT, BYTES);
      const [exists, contentHash] = await registry.verifyByByteHash(BYTES);
      expect(exists).to.equal(true);
      expect(contentHash).to.equal(CONTENT);
    });
  });

  describe("verification of unknown documents", function () {
    // A different person's ID of the same template must NOT resolve.
    it("returns not-found for an unanchored document", async function () {
      const [exists] = await registry.verify(h("content:degree:someone-else"));
      expect(exists).to.equal(false);
    });

    it("returns not-found for an unknown byte hash", async function () {
      const [exists] = await registry.verifyByByteHash(h("bytes:unknown.pdf"));
      expect(exists).to.equal(false);
    });
  });

  describe("revocation", function () {
    beforeEach(async function () {
      await registry.connect(issuer).anchor(CONTENT, BYTES);
    });

    it("lets the issuing authority revoke", async function () {
      await expect(registry.connect(issuer).revoke(CONTENT, "Issued in error"))
        .to.emit(registry, "Revoked")
        .withArgs(CONTENT, issuer.address, "Issued in error");
      const [, , , , revoked] = await registry.verify(CONTENT);
      expect(revoked).to.equal(true);
    });

    it("blocks a different institution from revoking", async function () {
      await expect(registry.connect(otherIssuer).revoke(CONTENT, "not mine"))
        .to.be.revertedWithCustomError(registry, "NotIssuingAuthority");
    });

    it("blocks double revocation", async function () {
      await registry.connect(issuer).revoke(CONTENT, "first");
      await expect(registry.connect(issuer).revoke(CONTENT, "second"))
        .to.be.revertedWithCustomError(registry, "AlreadyRevoked");
    });

    it("cannot revoke something never anchored", async function () {
      await expect(registry.connect(issuer).revoke(h("nope"), "x"))
        .to.be.revertedWithCustomError(registry, "NotAnchored");
    });
  });

  describe("admin handover", function () {
    it("requires the two-step accept", async function () {
      await registry.transferAdmin(outsider.address);
      expect(await registry.admin()).to.equal(admin.address); // not yet
      await registry.connect(outsider).acceptAdmin();
      expect(await registry.admin()).to.equal(outsider.address);
    });

    it("rejects acceptance from the wrong address", async function () {
      await registry.transferAdmin(outsider.address);
      await expect(registry.connect(issuer).acceptAdmin())
        .to.be.revertedWithCustomError(registry, "NotPendingAdmin");
    });

    it("rejects transfer to the zero address", async function () {
      await expect(registry.transferAdmin(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(registry, "ZeroAddress");
    });
  });

  describe("gas", function () {
    it("reports anchor cost", async function () {
      const tx = await registry.connect(issuer).anchor(CONTENT, BYTES);
      const r = await tx.wait();
      console.log("        anchor gas used:", r.gasUsed.toString());
      expect(r.gasUsed).to.be.lessThan(140000n);
    });
  });
});
