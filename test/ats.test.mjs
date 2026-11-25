import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fetchLiveAtsBoard, parseSlug, safeFetchText, validateSafeHttpUrl } from '../src/index.mjs';

test('parses company slugs (including ATS board URLs) and normalizes Greenhouse jobs', async () => {
  assert.equal(parseSlug('https://stripe.com'), 'stripe');
  assert.equal(parseSlug('https://boards.greenhouse.io/stripe'), 'stripe');
  assert.equal(parseSlug('https://jobs.ashbyhq.com/linear/123'), 'linear');

  const seenUrls = [];
  const mockFetch = async (u) => {
    seenUrls.push(String(u));
    if (String(u).includes('greenhouse')) {
      return new Response(
        JSON.stringify({
          jobs: [
            {
              title: 'Rust Engineer',
              location: { name: 'Remote' },
              first_published: '2026-01-01T00:00:00Z',
              absolute_url: 'https://boards.greenhouse.io/demo/jobs/1',
            },
          ],
        }),
        { status: 200 },
      );
    }
    return new Response('', { status: 404 });
  };
  const res = await fetchLiveAtsBoard('demo', { fetchImpl: mockFetch });
  assert.equal(res.ok, true);
  assert.equal(res.engine, 'Greenhouse');
  assert.equal(res.totalOpenJobs, 1);
  assert.equal(res.stuckRoles45d, 1);
  assert.ok(seenUrls.some((u) => u.includes('boards-api.greenhouse.io/v1/boards/demo/jobs')));
});

test('SSRF, redirect, byte-cap, and timeout/network error differentiation guards', async () => {
  assert.throws(() => parseSlug('http://127.0.0.1/jobs'));
  assert.throws(() => parseSlug('http://169.254.169.254/latest'));
  assert.throws(() => parseSlug('https://localhost:8080/board'));
  assert.throws(() => validateSafeHttpUrl('https://user:pass@boards.greenhouse.io/stripe'));
  assert.throws(() => validateSafeHttpUrl('https://boards.greenhouse.io:8443/stripe'));

  // Blocks SSRF redirect target
  const ssrfRedirectFetch = async () =>
    new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/admin' } });
  const rRedir = await safeFetchText('https://example.com/jobs', { fetchImpl: ssrfRedirectFetch });
  assert.equal(rRedir.ok, false);
  assert.equal(rRedir.status, 400);

  // Enforces >5 redirect hop limit
  const loopFetch = async () =>
    new Response(null, { status: 302, headers: { Location: 'https://example.com/next' } });
  const rLoop = await safeFetchText('https://example.com/start', { fetchImpl: loopFetch });
  assert.equal(rLoop.ok, false);
  assert.match(rLoop.error, /Too many redirects/i);

  // Enforces byte cap on streamed response
  const bigStream = new ReadableStream({
    start(ctrl) {
      ctrl.enqueue(new TextEncoder().encode('x'.repeat(2000)));
      ctrl.close();
    },
  });
  const capRes = await safeFetchText('https://example.com/big', {
    fetchImpl: async () => new Response(bigStream, { status: 200 }),
    maxBytes: 512,
  });
  assert.equal(capRes.ok, true);
  assert.equal(capRes.truncated, true);
  assert.equal(capRes.text.length, 512);

  // Surfaces timeout distinctly from 404
  const timeoutFetch = async () => {
    const err = new Error('Timed out');
    err.name = 'TimeoutError';
    throw err;
  };
  const timeoutRes = await fetchLiveAtsBoard('stripe', { fetchImpl: timeoutFetch });
  assert.equal(timeoutRes.ok, false);
  assert.equal(timeoutRes.status, 504);
  assert.match(timeoutRes.error, /timed out/i);

  // Lever uses &limit=50
  const leverUrls = [];
  await fetchLiveAtsBoard('palantir', {
    fetchImpl: async (u) => {
      leverUrls.push(String(u));
      return new Response('', { status: 404 });
    },
  });
  assert.ok(leverUrls.some((u) => u.includes('api.lever.co/v0/postings/palantir?mode=json&limit=50')));

  // CLI exits non-zero on invalid input
  let exitedNonZero = false;
  try {
    execFileSync(process.execPath, ['bin/cli.mjs', 'http://127.0.0.1/bad'], { encoding: 'utf8', stdio: 'pipe' });
  } catch (err) {
    exitedNonZero = err.status === 1;
  }
  assert.equal(exitedNonZero, true);
});
