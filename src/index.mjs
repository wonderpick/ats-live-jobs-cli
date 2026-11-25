const UA = 'Mozilla/5.0 (compatible; AtsLiveJobsCLI/1.1)';
const MAX_REDIRECTS = 5;
const MAX_JSON_BYTES = 1_500_000;
const ATS_TIMEOUT_MS = 8_000;

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal',
  'metadata.goog',
  'metadata',
  'instance-data',
]);

const BLOCKED_TLDS = ['.local', '.localhost', '.internal', '.lan', '.home', '.arpa', '.corp', '.metadata.goog'];

const ATS_BOARD_HOSTS = new Set([
  'boards.greenhouse.io',
  'job-boards.greenhouse.io',
  'jobs.ashbyhq.com',
  'jobs.lever.co',
]);

export function isBlockedHostnameOrIp(hostname) {
  if (!hostname || typeof hostname !== 'string') return true;
  const raw = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!raw) return true;
  if (/^\d+$/.test(raw) || /^0x[0-9a-f]+$/i.test(raw)) return true;
  if (/^(?:\d+|0x[0-9a-f]+)(?:\.(?:\d+|0x[0-9a-f]+)){1,3}$/i.test(raw)) return true;
  if (raw.includes(':')) return true;
  if (BLOCKED_HOSTNAMES.has(raw) || BLOCKED_TLDS.some((tld) => raw.endsWith(tld))) return true;
  return false;
}

export function validateSafeHttpUrl(rawUrl) {
  let u;
  try {
    u = new URL(String(rawUrl || '').trim());
  } catch {
    throw new Error('Invalid URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error('Only http/https URLs are allowed');
  }
  if (u.username || u.password) {
    throw new Error('URLs with embedded credentials are not allowed');
  }
  if (u.port && u.port !== '80' && u.port !== '443') {
    throw new Error('Non-standard URL ports are not allowed');
  }
  if (isBlockedHostnameOrIp(u.hostname)) {
    throw new Error(`Blocked internal/IP hostname (SSRF protection): ${u.hostname}`);
  }
  return u.toString();
}

async function readBoundedResponseText(res, maxBytes) {
  if (!res?.body) {
    const raw = typeof res?.text === 'function' ? await res.text() : '';
    const buf = Buffer.from(raw, 'utf8');
    if (buf.byteLength > maxBytes) {
      return { text: buf.subarray(0, maxBytes).toString('utf8'), truncated: true };
    }
    return { text: raw, truncated: false };
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      if (total + value.byteLength > maxBytes) {
        const remain = maxBytes - total;
        if (remain > 0) {
          chunks.push(Buffer.from(value.subarray(0, remain)));
          total += remain;
        }
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(Buffer.from(value));
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock?.();
  }
  return { text: Buffer.concat(chunks, total).toString('utf8'), truncated };
}

export async function safeFetchText(
  rawUrl,
  { fetchImpl = globalThis.fetch, headers = {}, timeoutMs = ATS_TIMEOUT_MS, maxRedirects = MAX_REDIRECTS, maxBytes = MAX_JSON_BYTES } = {},
) {
  let currentUrl;
  try {
    currentUrl = validateSafeHttpUrl(rawUrl);
  } catch (err) {
    return { ok: false, status: 400, error: err.message, text: '', truncated: false };
  }

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    let res;
    try {
      res = await fetchImpl(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      return {
        ok: false,
        status: timedOut ? 504 : 502,
        timedOut,
        networkError: !timedOut,
        error: timedOut ? 'Upstream request timed out' : err?.message || 'Network request failed',
        text: '',
        truncated: false,
      };
    }

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers?.get?.('location') || '';
      await res.body?.cancel?.().catch(() => {});
      if (!loc) {
        return { ok: false, status: res.status, error: 'Redirect missing Location header', text: '', truncated: false };
      }
      try {
        const nextAbs = new URL(loc, currentUrl).toString();
        currentUrl = validateSafeHttpUrl(nextAbs);
      } catch (err) {
        return { ok: false, status: 400, error: `Blocked redirect: ${err.message}`, text: '', truncated: false };
      }
      continue;
    }

    if (!res.ok) {
      await res.body?.cancel?.().catch(() => {});
      return { ok: false, status: res.status, error: `HTTP ${res.status}`, text: '', truncated: false };
    }

    const { text, truncated } = await readBoundedResponseText(res, maxBytes);
    return { ok: true, status: res.status, finalUrl: currentUrl, text, truncated };
  }

  return { ok: false, status: 502, error: `Too many redirects (>${maxRedirects})`, text: '', truncated: false };
}

export function parseSlug(raw) {
  const trimmed = String(raw || '').trim().toLowerCase();
  if (!trimmed || trimmed.length > 140 || /[\u0000-\u001F<>`{}\\]/.test(trimmed)) {
    throw new Error('Invalid company slug');
  }

  let candidate = trimmed;
  if (trimmed.includes('://') || trimmed.includes('.')) {
    let u;
    try {
      u = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    } catch {
      throw new Error('Invalid company URL or domain');
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      throw new Error('Only http/https URLs are allowed');
    }
    if (u.username || u.password) {
      throw new Error('URLs with credentials are not allowed');
    }
    if (u.port && u.port !== '80' && u.port !== '443') {
      throw new Error('Non-standard URL ports are not allowed');
    }
    if (isBlockedHostnameOrIp(u.hostname)) {
      throw new Error('Blocked internal/IP hostname (SSRF protection)');
    }
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (ATS_BOARD_HOSTS.has(host)) {
      const seg = u.pathname.replace(/^\/+/, '').split('/')[0];
      if (!seg) throw new Error('Missing ATS board slug in URL path');
      candidate = seg;
    } else {
      candidate = host.split('.')[0];
    }
  } else {
    candidate = trimmed.replace(/\s+/g, '');
  }

  const s = candidate.replace(/[^a-z0-9_-]/g, '');
  if (!/^[a-z0-9][a-z0-9_-]{0,60}$/.test(s)) {
    throw new Error('Invalid company slug');
  }
  return s;
}

function parseTruncatedJobs(text, maxJobs = 60) {
  const jobsMatch = /"jobs"\s*:\s*\[/.exec(text);
  const arrStart = jobsMatch ? jobsMatch.index + jobsMatch[0].length - 1 : text.trimStart().startsWith('[') ? text.indexOf('[') : -1;
  if (arrStart === -1) return null;

  const jobs = [];
  let inString = false;
  let escaped = false;
  let depth = 0;
  let objStart = -1;

  for (let i = arrStart + 1; i < text.length && jobs.length < maxJobs; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') {
      if (depth === 0) objStart = i;
      depth += 1;
    } else if (ch === '}') {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && objStart !== -1) {
          try {
            const parsed = JSON.parse(text.slice(objStart, i + 1));
            if (parsed && typeof parsed === 'object') jobs.push(parsed);
          } catch {}
          objStart = -1;
        }
      }
    } else if (ch === ']' && depth === 0) {
      break;
    }
  }
  if (jobs.length === 0) return null;
  return jobsMatch ? { jobs } : jobs;
}

export async function fetchLiveAtsBoard(rawCompany, { fetchImpl = globalThis.fetch } = {}) {
  const slug = parseSlug(rawCompany);
  const s = encodeURIComponent(slug);
  const endpoints = [
    ['Greenhouse', `https://boards-api.greenhouse.io/v1/boards/${s}/jobs`, (d) => (d.jobs || []).map((j) => ({ title: j.title, location: j.location?.name, postedAt: j.first_published || j.updated_at, url: j.absolute_url }))],
    ['Ashby', `https://api.ashbyhq.com/posting-api/job-board/${s}`, (d) => (d.jobs || []).map((j) => ({ title: j.title, location: j.location, postedAt: j.publishedAt, url: j.jobUrl }))],
    ['Lever', `https://api.lever.co/v0/postings/${s}?mode=json&limit=50`, (d) => (Array.isArray(d) ? d : []).map((j) => ({ title: j.text, location: j.categories?.location, postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : null, url: j.hostedUrl }))],
  ];

  const upstreamErrors = [];
  for (const [engine, url, mapFn] of endpoints) {
    const res = await safeFetchText(url, {
      fetchImpl,
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    if (!res.ok) {
      if (res.timedOut || res.networkError || res.status >= 500 || res.status === 400) {
        upstreamErrors.push({ engine, status: res.status, error: res.error });
      }
      continue;
    }

    let data;
    try {
      data = res.truncated ? parseTruncatedJobs(res.text) : JSON.parse(res.text);
    } catch {
      upstreamErrors.push({ engine, status: 502, error: 'Invalid JSON from upstream ATS' });
      continue;
    }
    const jobs = data ? mapFn(data) : [];
    if (jobs.length > 0) {
      const now = Date.now();
      const stuck45d = jobs.filter((j) => j.postedAt && (now - Date.parse(j.postedAt)) >= 45 * 86400000).length;
      return {
        ok: true,
        company: slug,
        engine,
        totalOpenJobs: jobs.length,
        stuckRoles45d: stuck45d,
        truncatedPreview: Boolean(res.truncated),
        jobs: jobs.slice(0, 20),
      };
    }
  }

  if (upstreamErrors.length > 0) {
    const anyTimeout = upstreamErrors.some((e) => e.status === 504);
    return {
      ok: false,
      company: slug,
      status: anyTimeout ? 504 : 502,
      error: anyTimeout ? 'Upstream ATS request timed out' : 'Upstream ATS network or server error',
      upstreamErrors,
    };
  }
  return { ok: false, company: slug, status: 404, error: 'No public Greenhouse, Ashby, or Lever board found' };
}
