const repository = 'ehomekevin/personal-ip-workbench-open-source';
const cacheKey = 'workbench:stable-release:v1';
const dismissedKey = 'workbench:dismissed-release:v1';
const hour = 60 * 60 * 1000;
const day = 24 * hour;

type CachedRelease = { tag: string | null; until: number };
let cached: CachedRelease | undefined;
let pending: Promise<string | null> | undefined;
let dismissed: string | null = null;

function read(key: string) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function write(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* In-memory state still works. */ }
}

function versionParts(value: unknown) {
  if (typeof value !== 'string' || value.length > 128) return null;
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.exec(value);
  if (!match || match[0] !== value || match[4]?.split('.').some(id => /^0\d+$/.test(id))) return null;
  return { core: match.slice(1, 4).map(n => BigInt(n)), prerelease: Boolean(match[4]) };
}

function readCache(): CachedRelease | undefined {
  let entry: unknown = cached;
  if (!entry) {
    try { entry = JSON.parse(read(cacheKey) || 'null'); } catch { return; }
  }
  if (!entry || typeof entry !== 'object' || !('until' in entry) || !('tag' in entry)) return;
  const { tag, until } = entry;
  const now = Date.now();
  if (typeof until !== 'number' || !Number.isFinite(until) || until <= now || until > now + day) return;
  if (tag !== null && (typeof tag !== 'string' || !versionParts(tag))) return;
  return cached = { tag, until };
}

async function fetchLatestTag(): Promise<string | null> {
  let tag: string | null = null;
  let ttl = hour;
  try {
    const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
      credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store',
      signal: AbortSignal.timeout(4000),
    });
    if (response.ok) {
      const release = await response.json();
      const parsed = versionParts(release?.tag_name);
      if (release?.draft === false && release.prerelease === false && parsed && !parsed.prerelease) tag = release.tag_name;
      ttl = day;
    } else if (response.status === 404) {
      ttl = day;
    } else if (response.status === 403 || response.status === 429) {
      const retrySeconds = Number(response.headers.get('Retry-After'));
      if (Number.isFinite(retrySeconds)) ttl = Math.min(day, Math.max(hour, retrySeconds * 1000));
    }
  } catch { /* Optional network checks must never interrupt the workbench. */ }
  cached = { tag, until: Date.now() + ttl };
  write(cacheKey, JSON.stringify(cached));
  return tag;
}

export async function checkReleaseUpdate(currentVersion: string): Promise<{ version: string; url: string } | null> {
  const current = versionParts(currentVersion);
  if (!current) return null;
  const previous = readCache();
  const tag = previous ? previous.tag : await (pending ??= fetchLatestTag().finally(() => { pending = undefined; }));
  const latest = versionParts(tag);
  if (!tag || !latest || latest.prerelease) return null;
  const difference = latest.core.findIndex((n, i) => n !== current.core[i]);
  if (difference < 0 ? !current.prerelease : latest.core[difference] < current.core[difference]) return null;
  const version = tag.replace(/^v/, '');
  if (version === dismissed || version === read(dismissedKey)) return null;
  return { version, url: `https://github.com/${repository}/releases/tag/${encodeURIComponent(tag)}` };
}

export function dismissReleaseUpdate(version: string): void {
  dismissed = version;
  write(dismissedKey, version);
}
