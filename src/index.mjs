const UA = 'Mozilla/5.0 (compatible; AtsLiveJobsCLI/1.0)';

export function parseSlug(raw) {
  const s = String(raw || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/.]/)[0].replace(/[^a-z0-9_-]/g, '');
  if (!/^[a-z0-9][a-z0-9_-]{0,60}$/.test(s)) throw new Error('Invalid company slug');
  return s;
}

export async function fetchLiveAtsBoard(rawCompany, { fetchImpl = globalThis.fetch } = {}) {
  const slug = parseSlug(rawCompany);
  const endpoints = [
    ['Greenhouse', 'https://boards-api.greenhouse.io/v1/boards/' + slug + '/jobs', (d) => (d.jobs || []).map((j) => ({ title: j.title, location: j.location?.name, postedAt: j.first_published || j.updated_at, url: j.absolute_url }))],
    ['Ashby', 'https://api.ashbyhq.com/posting-api/job-board/' + slug, (d) => (d.jobs || []).map((j) => ({ title: j.title, location: j.location, postedAt: j.publishedAt, url: j.jobUrl }))],
    ['Lever', 'https://api.lever.co/v0/postings/' + slug + '?mode=json', (d) => (Array.isArray(d) ? d : []).map((j) => ({ title: j.text, location: j.categories?.location, postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : null, url: j.hostedUrl }))],
  ];
  for (const [engine, url, mapFn] of endpoints) {
    try {
      const r = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const jobs = mapFn(await r.json());
      if (jobs.length > 0) {
        const now = Date.now();
        const stuck45d = jobs.filter((j) => j.postedAt && (now - Date.parse(j.postedAt)) >= 45 * 86400000).length;
        return { ok: true, company: slug, engine, totalOpenJobs: jobs.length, stuckRoles45d: stuck45d, jobs: jobs.slice(0, 20) };
      }
    } catch {}
  }
  return { ok: false, company: slug, error: 'No public Greenhouse, Ashby, or Lever board found' };
}
