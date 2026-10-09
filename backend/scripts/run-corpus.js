#!/usr/bin/env node
// Runs the forgery corpus through the real verification pipeline and prints a confusion matrix.
//
//   npm run corpus                       the committed corpus (digital files and SIMULATED captures)
//   npm run corpus -- --dir <folder>     files in <folder> with the same names REPLACE the corpus files, so real captures are judged
//                                        by the same expectations (see ../corpus/CAPTURE.md)
//   npm run corpus -- --json             machine-readable output
const path = require('node:path');
const fs = require('node:fs');
const { runCorpus, formatReport } = require('../test/corpus-runner');
const { shutdown } = require('../ocr');

const args = process.argv.slice(2);
const dirAt = args.indexOf('--dir');
const overrideDir = dirAt >= 0 ? path.resolve(args[dirAt + 1] || '') : null;
if (overrideDir && !fs.existsSync(overrideDir)) { console.error(`No such folder: ${overrideDir}`); process.exit(2); }

runCorpus({ overrideDir })
    .then((report) => {
        console.log(args.includes('--json') ? JSON.stringify({ results: report.results, matrix: report.matrix }, null, 2) : formatReport(report));
        process.exitCode = report.results.every((r) => r.ok) ? 0 : 1;
    })
    .catch((err) => { console.error(err.message); process.exitCode = 2; })
    .finally(() => shutdown());
