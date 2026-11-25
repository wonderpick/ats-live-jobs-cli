#!/usr/bin/env node
import { fetchLiveAtsBoard } from '../src/index.mjs';

const arg = process.argv[2];
if (!arg || arg === '-h' || arg === '--help') {
  console.log('Usage: ats-jobs <company-slug>  (e.g. stripe, anthropic, figma, linear)');
  console.log('Free Web Tool: https://wonderpick.github.io/apify-b2b-ecom-automation-kit/tools/ats-jobs-checker.html');
  process.exit(0);
}

try {
  const res = await fetchLiveAtsBoard(arg);
  console.log(JSON.stringify(res, null, 2));
  if (!res?.ok) process.exitCode = 1;
} catch (err) {
  console.error(JSON.stringify({ ok: false, error: err?.message || String(err) }, null, 2));
  process.exitCode = 1;
}
