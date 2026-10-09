// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title  CredentialRegistry
 * @notice Anchors document fingerprints issued by authorised institutions.
 *
 * Design notes
 * ------------
 * 1. Records are keyed by `contentHash` (Tier 2 — the canonical hash of the
 *    document's extracted fields), not by the raw file hash. A genuine document
 *    that has been scanned, photographed or recompressed produces different
 *    bytes but the same content hash, so it still resolves.
 *
 * 2. `byteHash` (Tier 1 — SHA-256 of the original file) is stored alongside so a
 *    verifier presenting the pristine original can be told so explicitly, and so
 *    it can be looked up directly.
 *
 * 3. The perceptual hash (Tier 3) is deliberately NOT stored here. It is a
 *    similarity score compared against a tunable threshold; committing a fuzzy
 *    value to an immutable ledger would imply a certainty it does not carry.
 *    It lives off-chain in MongoDB.
 *
 * 4. `anchor` is gated on an issuer allowlist. Without this, a successful
 *    verification would prove only "some address registered these bytes" rather
 *    than "an authorised institution issued this document".
 *
 * 5. Revocation reasons are emitted in events but not stored. Events are far
 *    cheaper than storage and remain permanently retrievable.
 */
contract CredentialRegistry {
    // ---------------------------------------------------------------- errors

    error NotAdmin();
    error NotPendingAdmin();
    error NotAuthorisedIssuer();
    error NotIssuingAuthority();
    error AlreadyAnchored();
    error NotAnchored();
    error AlreadyRevoked();
    error ZeroAddress();
    error ZeroHash();
    error EmptyName();

    // ---------------------------------------------------------------- types

    /// @dev Packs into two storage slots: (address|uint64|bool) + bytes32.
    struct Record {
        address issuer;    // 20 bytes ─┐
        uint64  issuedAt;  //  8 bytes  ├─ slot 0
        bool    revoked;   //  1 byte  ─┘
        bytes32 byteHash;  // 32 bytes ── slot 1
    }

    // ---------------------------------------------------------------- state

    address public admin;
    address public pendingAdmin;

    /// @notice Non-empty name ⇒ address is an authorised issuer.
    mapping(address => string) public issuerName;

    /// @notice contentHash ⇒ record
    mapping(bytes32 => Record) private _records;

    /// @notice byteHash ⇒ contentHash, so an exact original resolves directly.
    mapping(bytes32 => bytes32) public contentHashOf;

    uint256 public totalAnchored;

    // --------------------------------------------------------------- events

    event AdminTransferStarted(address indexed from, address indexed to);
    event AdminTransferred(address indexed from, address indexed to);
    event IssuerRegistered(address indexed issuer, string name);
    event IssuerRemoved(address indexed issuer);
    event Anchored(bytes32 indexed contentHash, bytes32 indexed byteHash, address indexed issuer, uint64 issuedAt);
    event Revoked(bytes32 indexed contentHash, address indexed issuer, string reason);

    // ------------------------------------------------------------ modifiers

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier onlyIssuer() {
        if (bytes(issuerName[msg.sender]).length == 0) revert NotAuthorisedIssuer();
        _;
    }

    constructor() {
        admin = msg.sender;
        emit AdminTransferred(address(0), msg.sender);
    }

    // ------------------------------------------------------- administration

    /**
     * @notice Two-step admin handover. The new admin must call `acceptAdmin`,
     *         which makes it impossible to lock the contract by transferring to
     *         a mistyped or uncontrolled address.
     */
    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        pendingAdmin = newAdmin;
        emit AdminTransferStarted(admin, newAdmin);
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotPendingAdmin();
        address previous = admin;
        admin = pendingAdmin;
        pendingAdmin = address(0);
        emit AdminTransferred(previous, admin);
    }

    /// @notice Add an institution to the issuer allowlist.
    function registerIssuer(address issuer, string calldata name) external onlyAdmin {
        if (issuer == address(0)) revert ZeroAddress();
        if (bytes(name).length == 0) revert EmptyName();
        issuerName[issuer] = name;
        emit IssuerRegistered(issuer, name);
    }

    /**
     * @notice Remove an issuer's authority to anchor new documents.
     * @dev    Documents they already anchored remain valid — removing an issuer
     *         is not a bulk revocation. Revoke individual records explicitly.
     */
    function removeIssuer(address issuer) external onlyAdmin {
        delete issuerName[issuer];
        emit IssuerRemoved(issuer);
    }

    // ------------------------------------------------------------ anchoring

    /**
     * @notice Anchor a document. Callable only by a registered issuer.
     * @param contentHash Tier 2 — canonical hash of extracted fields.
     * @param byteHash    Tier 1 — SHA-256 of the original file.
     */
    function anchor(bytes32 contentHash, bytes32 byteHash) external onlyIssuer {
        if (contentHash == bytes32(0) || byteHash == bytes32(0)) revert ZeroHash();
        if (_records[contentHash].issuedAt != 0) revert AlreadyAnchored();

        _records[contentHash] = Record({
            issuer:   msg.sender,
            issuedAt: uint64(block.timestamp),
            revoked:  false,
            byteHash: byteHash
        });
        contentHashOf[byteHash] = contentHash;

        unchecked { ++totalAnchored; }
        emit Anchored(contentHash, byteHash, msg.sender, uint64(block.timestamp));
    }

    /// @notice Revoke a document. Only the institution that issued it may do so.
    function revoke(bytes32 contentHash, string calldata reason) external {
        Record storage r = _records[contentHash];
        if (r.issuedAt == 0) revert NotAnchored();
        if (r.issuer != msg.sender) revert NotIssuingAuthority();
        if (r.revoked) revert AlreadyRevoked();

        r.revoked = true;
        emit Revoked(contentHash, msg.sender, reason);
    }

    // --------------------------------------------------------- verification

    /**
     * @notice Verify by content hash — the resilient path. Works for a scan,
     *         photograph or compressed copy of a genuine document.
     */
    function verify(bytes32 contentHash)
        external
        view
        returns (
            bool    exists,
            address issuer,
            string  memory name,
            uint64  issuedAt,
            bool    revoked,
            bytes32 byteHash
        )
    {
        Record memory r = _records[contentHash];
        return (
            r.issuedAt != 0,
            r.issuer,
            issuerName[r.issuer],
            r.issuedAt,
            r.revoked,
            r.byteHash
        );
    }

    /**
     * @notice Verify by file hash — the strict path. A match here means the
     *         caller holds the untouched original file, not merely a copy.
     */
    function verifyByByteHash(bytes32 byteHash)
        external
        view
        returns (bool exists, bytes32 contentHash, address issuer, string memory name, uint64 issuedAt, bool revoked)
    {
        bytes32 ch = contentHashOf[byteHash];
        if (ch == bytes32(0)) return (false, bytes32(0), address(0), "", 0, false);
        Record memory r = _records[ch];
        return (true, ch, r.issuer, issuerName[r.issuer], r.issuedAt, r.revoked);
    }

    function isIssuer(address account) external view returns (bool) {
        return bytes(issuerName[account]).length != 0;
    }

    function isAnchored(bytes32 contentHash) external view returns (bool) {
        return _records[contentHash].issuedAt != 0;
    }
}
