// Audits (and with --apply, fixes) the S3 bucket settings the app relies on.
//   npm run check-bucket            read-only report; exits 1 if anything is wrong
//   npm run check-bucket -- --apply turns on Block Public Access, versioning and default encryption
// Needs real AWS credentials in .env; it makes calls to AWS.
require('dotenv').config({ quiet: true });
const {
    S3Client, GetPublicAccessBlockCommand, PutPublicAccessBlockCommand, GetBucketVersioningCommand,
    PutBucketVersioningCommand, GetBucketEncryptionCommand, PutBucketEncryptionCommand,
} = require('@aws-sdk/client-s3');

const ALL_BLOCKED = {
    BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true,
};

/** Reads the three settings. Anything that cannot be read counts as not OK. */
async function auditBucket(s3, bucket) {
    const settle = async (fn) => { try { return { value: await fn() }; } catch (err) { return { error: err.name || 'Error' }; } };
    const pab = await settle(() => s3.send(new GetPublicAccessBlockCommand({ Bucket: bucket })));
    const ver = await settle(() => s3.send(new GetBucketVersioningCommand({ Bucket: bucket })));
    const enc = await settle(() => s3.send(new GetBucketEncryptionCommand({ Bucket: bucket })));
    const cfg = pab.value && pab.value.PublicAccessBlockConfiguration;
    const rule = enc.value && enc.value.ServerSideEncryptionConfiguration && enc.value.ServerSideEncryptionConfiguration.Rules
        && enc.value.ServerSideEncryptionConfiguration.Rules[0];
    return [
        { name: 'Block Public Access (all four settings)', ok: !!cfg && Object.keys(ALL_BLOCKED).every((k) => cfg[k] === true), detail: pab.error },
        { name: 'Versioning enabled', ok: !!ver.value && ver.value.Status === 'Enabled', detail: ver.error },
        { name: 'Default encryption', ok: !!rule, detail: enc.error || (rule && rule.ApplyServerSideEncryptionByDefault.SSEAlgorithm) },
    ];
}

async function applyFixes(s3, bucket) {
    await s3.send(new PutPublicAccessBlockCommand({ Bucket: bucket, PublicAccessBlockConfiguration: ALL_BLOCKED }));
    await s3.send(new PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: 'Enabled' } }));
    await s3.send(new PutBucketEncryptionCommand({
        Bucket: bucket,
        ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] },
    }));
}

async function main(argv = process.argv.slice(2)) {
    const { BUCKET_NAME, REGION } = process.env;
    if (!BUCKET_NAME || !REGION) { console.error('BUCKET_NAME and REGION must be set'); return 1; }
    const s3 = new S3Client({ region: REGION });
    if (argv.includes('--apply')) { await applyFixes(s3, BUCKET_NAME); console.log('Applied. Re-checking...'); }
    const results = await auditBucket(s3, BUCKET_NAME);
    for (const r of results) console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.name}${r.detail ? ` (${r.detail})` : ''}`);
    return results.every((r) => r.ok) ? 0 : 1;
}

if (require.main === module) main().then((code) => process.exit(code), (err) => { console.error(err.name || 'Error', '-', err.message); process.exit(1); });

module.exports = { auditBucket, applyFixes, ALL_BLOCKED };
