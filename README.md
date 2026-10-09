#  MindForge: Decentralized Document Verification System

> **A Hybrid Architecture solution combining the speed of Cloud (AWS) with the trust of Blockchain (Ethereum) to fight deepfakes and document fraud.**

---

##  Overview
MindForge is a tamper-proof document verification platform designed to issue and verify credentials (educational degrees, land deeds, CCTV evidence) without compromising user privacy.

Unlike traditional solutions that are either **too slow** (storing files on-chain) or **insecure** (centralized databases), MindForge uses a **Hybrid "Golden Mean" Architecture**:
1.  **Storage:** Heavy files are encrypted and stored in **AWS S3** (Cloud Vault).
2.  **Trust:** Only the **SHA-256 Cryptographic Hash** is locked on the **Ethereum Blockchain**.

This ensures **GDPR Compliance** (Right to be Forgotten) and **Zero-Cost Scalability** (verifying a 10GB video costs the same as a 1KB PDF).

---

##  Key Features (Novelty)
### 1. Hybrid "Decoupled" Architecture
We separate storage costs from verification costs. By storing only the hash on-chain, we bypass Ethereum's high gas fees for data storage, making this solution scalable for 1.4 Billion people.

### 2. Automated Forensic Officer Portal
No manual hash checking. Officers simply upload a suspect file, and our "Auto-Hash Engine" instantly generates the fingerprint and cross-references it with the immutable blockchain ledger to detect **Deepfakes** or modifications.

### 3. Privacy-First & GDPR Compliant
We never store personal data (names, addresses) on the public blockchain. We only store the mathematical proof of existence. If a user requests deletion, we remove the file from AWS, but the integrity record remains—solving the "Blockchain vs. Privacy" paradox.

---

## Tech Stack

| Component | Technology Used | Purpose |
| :--- | :--- | :--- |
| **Frontend** | React.js + Vite | Responsive User Interface for Citizens & Officers |
| **Backend** | Node.js + Express | Handling file streams & AWS connections |
| **Cloud Storage** | AWS S3 (Mumbai) | Secure, scalable "off-chain" file vault |
| **Blockchain** | Ethereum (Sepolia) | Immutable ledger for hash recording |
| **Smart Contract** | Solidity | Logic for locking and verifying hashes |
| **Wallet** | MetaMask | Web3 authentication & signing |

---

##  Installation & Setup
Follow these steps to run the project locally.

### 1. Clone the Repository
```bash
git clone [https://github.com/ROHIT-JR/MindForge.git](https://github.com/ROHIT-JR/MindForge.git)
cd MindForge
2. Backend Setup (The Engine)
Navigate to the backend folder and install dependencies.

Bash
cd backend
npm install
Configure Environment Variables: Create a .env file in the backend folder and add your AWS credentials:

Code snippet
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key
BUCKET_NAME=mindforge-storage-2026
REGION=ap-south-1
Start the Server:

Bash
node server.js
Output should say: MindForge AWS Backend running on port 5000

3. Frontend Setup (The Interface)
Open a new terminal and navigate to the frontend folder.
Bash
cd frontend
npm install
npm run dev
Open http://localhost:5173 in your browser.

Usage Guide
Phase 1: The Citizen (Issuer)
Login to the Citizen Portal.


Select a document (PDF, Image, Video).
Step 1: Click "Upload to Cloud Vault" (Stores in AWS S3).
Step 2: Click "Lock on Blockchain" (MetaMask will pop up to sign the transaction).
Success: The document is now immutable!

Phase 2: The Officer (Verifier)
Login to the Officer Portal (PIN: admin123).
Upload a "Suspect Document" received from a user.
Click "Verify Integrity".


Result:
 VERIFIED AUTHENTIC: The file is 100% original.
 FAKE DOCUMENT: The file has been tampered with (even 1 pixel change).

**Future Roadmap**
Zero-Knowledge Proofs (ZKPs): Verify age/status without revealing the actual birthdate.
IPFS Integration: Option for fully decentralized storage for censorship resistance.
NFC Mobile App: Tap-to-verify for police officers on the field.

License
This project is open-source under the MIT License.
