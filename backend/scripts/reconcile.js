// Recovery sweep for issuance that stopped half way. Safe to run repeatedly (for example from a scheduler).
//   npm run reconcile
// Looks at records unchanged for 10 minutes: PENDING ones become FAILED (a retry reuses them), BLOCKCHAIN_PENDING
// ones are checked against the chain (RPC_URL) and become ISSUED or FAILED. It prints record ids only.
require('dotenv').config({ quiet: true });
const { connectDocuments } = require('../db');
const { createIssuance } = require('../issuance');
const { createChain } = require('../chain');

async function main() {
    if (!process.env.MONGODB_URI) { console.error('MONGODB_URI must be set'); return 1; }
    const documents = await connectDocuments(process.env.MONGODB_URI);
    try {
        const chain = process.env.RPC_URL ? createChain({ rpcUrl: process.env.RPC_URL, chainId: Number(process.env.CHAIN_ID) || undefined, contractAddress: process.env.CONTRACT_ADDRESS || undefined }) : null;
        const issuance = createIssuance({ documents, storage: null, chain, contractAddress: process.env.CONTRACT_ADDRESS || undefined });
        const report = await issuance.reconcile();
        console.log(JSON.stringify(report, null, 2));
        if (!chain && report.unverified.length) console.error('RPC_URL is not set: BLOCKCHAIN_PENDING records could not be verified.');
        return 0;
    } finally {
        await documents.close();
    }
}

main().then((code) => process.exit(code), (err) => { console.error(err.name || 'Error', '-', String(err.message).replace(/mongodb(\+srv)?:\/\/\S+/gi, '[REDACTED]')); process.exit(1); });
