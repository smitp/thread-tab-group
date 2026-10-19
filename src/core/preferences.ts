import type { Snapshot, Tab, Thread } from './types';

// Preferences are derived from live examples, not stored rules or browsing
// history. Group identities/membership snapshots support continuity and detect
// later manual ungrouping even when Thread has not appended to that group.
export function referenceThreads(snapshot: Snapshot, saved: Thread[]): Thread[] {
  const known = saved.filter(t => t.windowKey === snapshot.windowKey);
  return [...known, ...snapshot.groups.filter(g => !known.some(t => t.groupId === g.id)).map(g => ({
    id: `manual:${snapshot.windowKey}:${g.id}`, origin: 'user' as const,
    windowKey: snapshot.windowKey, groupId: g.id, epoch: snapshot.epoch,
    title: g.title, color: g.color,
    keys: snapshot.tabs.filter(t => t.groupId === g.id).map(t => t.key), updatedAt: Date.now(),
  }))];
}

const generic = new Set('www com org net co uk io edu gov app html php index docs documentation document d articles blog news search issues pulls tree blob settings projects users'.split(' '));
function normalized(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
function address(tab: Tab) {
  const url = new URL(tab.url);
  const host = url.hostname.replace(/^www\./, '');
  const path = url.pathname.split('/').filter(Boolean).slice(0, 2);
  return { host, path: host === 'github.com' ? path.map(p => p.toLowerCase()) : path };
}
function domainName(title: string, host: string): boolean {
  const name = normalized(title).replace(/\b(all|tabs?|links?|pages?|stuff|repos?|repositories|projects?)\b/g, '').replace(/\s+/g, ' ').trim();
  const parts = host.split('.');
  if (parts.length > 1) parts.pop(); // Ignore the TLD, not meaningful subdomains such as docs.google.
  if (parts.length > 1 && /^(co|com|org|net|gov|ac)$/.test(parts.at(-1)!)) parts.pop();
  return !!name && [normalized(host), normalized(parts.join(' ')), normalized([...parts].reverse().join(' ')), parts.at(-1)].includes(name);
}
function workflow(title: string): boolean {
  // Status/intent cannot be inferred from what a page is about.
  return /\b(read later|to read|to do|todo|inbox|someday|wishlist|to buy|done|completed|archive)\b/.test(normalized(title)) ||
    /^(reading|later|saved|pending)$/.test(normalized(title));
}

export interface GroupPreference {
  thread: Thread;
  members: Tab[];
  container: string;
  domain?: string;
  paths: { host: string; path: string[] }[];
}

export function groupPreferences(snapshot: Snapshot, threads: Thread[]): GroupPreference[] {
  return threads.flatMap(thread => {
    const all = snapshot.tabs.filter(t => t.groupId === thread.groupId);
    // Never append into hidden or mixed-container groups. Reading reference
    // titles does not move playing/sharing tabs that are already in a group.
    if (!all.length || snapshot.groups.find(g => g.id === thread.groupId)?.protected || all.some(t => t.hidden) || new Set(all.map(t => t.container)).size !== 1 ||
      (thread.origin === 'user' && workflow(thread.title))) return [];
    const members = all.filter(t => /^https?:\/\//.test(t.url));
    if (!members.length) return [];
    const preference: GroupPreference = { thread, members, container: all[0].container, paths: [] };
    if (thread.origin !== 'user') return [preference];
    const addresses = members.map(address);
    const hosts = [...new Set(addresses.map(a => a.host))];
    if (members.length >= 2 && hosts.length === 1 && domainName(thread.title, hosts[0])) preference.domain = hosts[0];
    // Google Docs, Sheets, Slides, and Forms share a hostname. An explicitly
    // named product group is narrower than a general Google/site group.
    const products: Record<string, string[]> = {
      document: ['docs', 'google docs', 'documents'], spreadsheets: ['sheets', 'google sheets', 'spreadsheets'],
      presentation: ['slides', 'google slides', 'presentations'], forms: ['forms', 'google forms'],
    };
    const documents = addresses.filter(a => a.host === 'docs.google.com');
    const product = documents[0]?.path[0];
    if (product && documents.every(a => a.path[0] === product) && products[product]?.includes(normalized(thread.title))) {
      preference.domain = undefined;
      preference.paths.push({ host: 'docs.google.com', path: [product] });
    }
    // A generic/unnamed GitHub group spanning several repositories is also
    // evidence of a site-wide preference. A project/role name is not.
    if (!preference.domain && hosts.length === 1 && hosts[0] === 'github.com' &&
      /^(|new group|untitled|tabs|group)$/.test(normalized(thread.title)) &&
      new Set(addresses.filter(a => a.path.length === 2).map(a => a.path.join('/'))).size >= 3) preference.domain = hosts[0];
    if (!preference.domain) for (const host of hosts) {
      const paths = addresses.filter(a => a.host === host).map(a => a.path);
      const prefix: string[] = [];
      for (let i = 0; i < paths[0].length && paths.every(p => p[i] === paths[0][i]); i++) prefix.push(paths[0][i]);
      const namedRepo = host === 'github.com' && prefix.length === 2 &&
        normalized(thread.title).replace(/\b(project|repo|repository|code)\b/g, '').replace(/\s+/g, ' ').trim() === normalized(prefix[1]);
      if (paths.length < 2 && !namedRepo) continue;
      if (!prefix.length || prefix.some(p => p.length > 60 || /[0-9a-f]{12,}|[0-9]{5,}/i.test(p)) ||
        generic.has(prefix.at(-1)!.toLowerCase()) || /^\d+$/.test(prefix.at(-1)!)) continue;
      // One URL segment often means a broad site section or GitHub owner.
      if (prefix.length === 1 && normalized(thread.title) !== normalized(prefix[0])) continue;
      preference.paths.push({ host, path: prefix });
    }
    return [preference];
  });
}

export function preferenceMatch(tab: Tab, preference: GroupPreference): number {
  if (tab.container !== preference.container) return 0;
  const { host, path } = address(tab);
  if (preference.domain === host) return 10;
  const matches = preference.paths.filter(p => p.host === host && p.path.every((part, i) => path[i] === part));
  return matches.length ? 20 + Math.max(...matches.map(p => p.path.length)) : 0;
}

export function acceptsSemantic(tab: Tab, preference: GroupPreference): boolean {
  if (tab.container !== preference.container) return false;
  const { host, path } = address(tab);
  // A site-named group is a boundary, not merely an attractive topic centroid.
  if (preference.domain) return host === preference.domain;
  const scopes = preference.paths.filter(p => p.host === host);
  return !scopes.length || scopes.some(p => p.path.every((part, i) => path[i] === part));
}
