import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchLiveAtsBoard, parseSlug } from '../src/index.mjs';

test('parses company slugs and normalizes Greenhouse jobs', async () => {
  assert.equal(parseSlug('https://stripe.com'), 'stripe');
  const mockFetch = async (u) => u.includes('greenhouse')
    ? new Response(JSON.stringify({ jobs: [{ title: 'Rust Engineer', location: { name: 'Remote' }, first_published: '2026-01-01T00:00:00Z', absolute_url: 'https://boards.greenhouse.io/demo/jobs/1' }] }), { status: 200 })
    : new Response('', { status: 404 });
  const res = await fetchLiveAtsBoard('demo', { fetchImpl: mockFetch });
  assert.equal(res.engine, 'Greenhouse');
  assert.equal(res.totalOpenJobs, 1);
  assert.equal(res.stuckRoles45d, 1);
});
