import type { AppState, GroupingStyle, Snapshot, Tab, Thread } from './types';
import { referenceThreads } from './preferences';

const stop = new Set(('a an and are as at be by can com do for from get how i in is it of on or that the this to with you your www html https http home page new tab search google bing duckduckgo youtube reddit github docs documentation official site').split(' '));

export function words(value: string): string[] {
  return value.toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]{2,}/gu)?.filter(w => !stop.has(w) && !/^\d+$/.test(w)) ?? [];
}
// Strip attribution only when it matches the host, not an arbitrary final
// phrase (which might be the most useful part of the title).
export function pageTitle(tab: Tab, forLabel = false): string {
  let title = tab.title.replace(/^\(\d+\)\s*/, '').replace(/\s+/g, ' ').trim();
  const host = new URL(tab.url).hostname.replace(/^www\./, '');
  const parts = host.split('.');
  parts.pop();
  if (parts.length > 1 && /^(co|com|org|net|gov|ac)$/.test(parts.at(-1)!)) parts.pop();
  const brand = parts.at(-1) ?? '';
  const normalize = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const path = new URL(tab.url).pathname.split('/').filter(Boolean);
  // A named blog followed by a dated article can live on a shared hostname.
  const blog = path.find((part, i) => part.length < 60 && /^[12]\d{3}$/.test(path[i + 1] ?? '') && /^\d{1,2}$/.test(path[i + 2] ?? ''));
  const attribution = (s: string) => {
    const name = normalize(s.replace(/\b(official|website|site|blog|news|online|search|docs)\b/gi, ''));
    const first = s.toLowerCase().match(/^[\p{L}\p{N}]+/u)?.[0];
    return (brand.length >= 3 && (normalize(s) === normalize(host) || normalize(s) === brand || name === brand || first === brand)) ||
      (!!blog && normalize(s) === normalize(blog));
  };
  const chunks = title.split(/\s+[|–—/»\-]\s+/);
  while (chunks.length > 1 && attribution(chunks.at(-1)!)) chunks.pop();
  while (chunks.length > 1 && attribution(chunks[0])) chunks.shift();
  if (forLabel) {
    // Headlines precede breadcrumbs/department names. A meaningful headline
    // is sufficient for naming; generic navigation still needs its context.
    const navigation = /^(home|welcome|about|pricing|overview|introduction|information|index|details|summary|comments|discussion|forum|login|account|settings|profile|dashboard|untitled|loading|what|why)$/i;
    if (!/\b(blog|topics?|news|reviews?|index|portal)\s*$/i.test(chunks[0]) && words(chunks[0]).some(word => !navigation.test(word))) return chunks[0];
  }
  title = chunks.join(' — ');
  return title || tab.title.trim();
}
export function titleText(tab: Tab): string {
  const title = pageTitle(tab);
  const url = new URL(tab.url);
  // No query strings, fragments, credentials, or opaque document IDs in inference.
  const path = url.pathname.split('/').filter(p => p.length < 30 && !/[0-9a-f]{12,}|[0-9]{5,}/i.test(p))
    .slice(0, 3).map(p => { try { return decodeURIComponent(p).replace(/[-_]/g, ' '); } catch { return ''; } }).join(' ');
  // An informative title is the subject, not the publisher. Repeating host and
  // URL words biases otherwise-related pages toward separate site clusters.
  const generic = /^(home|welcome|login|sign|in|up|dashboard|account|accounts|settings|profile|results|untitled|new|tab|document|overview|introduction|loading|please|wait|error|forbidden|access|denied)$/i;
  if (words(title).some(word => !generic.test(word))) return title.slice(0, 600);
  return (title + ' ' + url.hostname.replace(/^www\./, '') + ' ' + path).slice(0, 600);
}
export function eligible(tab: Tab): boolean {
  return /^https?:\/\//.test(tab.url) && !tab.pinned && !tab.hidden && !tab.busy;
}
export function sharedTool(tab: Tab): boolean {
  try {
    const u = new URL(tab.url);
    return (/^(mail|outlook|calendar)\./.test(u.hostname) &&
      (/inbox|calendar|mail/i.test(tab.title)) && !/\/message\/|\/event\//.test(u.pathname)) ||
      ((u.hostname === 'github.com' || u.hostname === 'www.notion.so') && u.pathname === '/');
  } catch { return false; }
}
export function reconcile(state: AppState, snapshot: Snapshot): Thread[] {
  const memory = state.windows[snapshot.windowKey] ??= { ignored: [] };
  const present = new Set(snapshot.tabs.map(t => t.key));
  memory.ignored = memory.ignored.filter(k => present.has(k));
  memory.retryKeys = memory.retryKeys?.filter(k => memory.ignored.includes(k) && snapshot.tabs.some(t => t.key === k && t.groupId === -1));
  memory.regroupKeys = memory.regroupKeys?.filter(k => !memory.ignored.includes(k) && snapshot.tabs.some(t => t.key === k && t.groupId === -1));
  const exclude = (key: string) => {
    memory.ignored.push(key);
    // A subsequent manual ungroup is a correction, not permission to retry Undo.
    memory.retryKeys = memory.retryKeys?.filter(k => k !== key);
    memory.regroupKeys = memory.regroupKeys?.filter(k => k !== key);
  };
  const undoReleased = new Set([...(memory.undo?.detachedKeys ?? []), ...(memory.undo?.detachingKeys ?? [])]
    .filter(key => snapshot.tabs.some(t => t.key === key && t.groupId === -1)));
  const used = new Set<number>();
  const result: Thread[] = [];
  for (const stored of state.threads.filter(t => t.windowKey === snapshot.windowKey)) {
    // A recovery popup may observe our own already-journaled Undo detachment.
    // Do not permanently reclassify its surviving AI group as user-corrected.
    const saved = { ...stored, keys: stored.keys.filter(key => !undoReleased.has(key)) };
    let group = snapshot.groups.find(g => g.id === saved.groupId &&
      snapshot.tabs.some(t => t.groupId === g.id && saved.keys.includes(t.key)));
    if (saved.epoch !== snapshot.epoch) {
      // Rebind restored groups by surviving opaque tab identities, not reused numeric IDs.
      const candidates = snapshot.groups.map(g => ({
        group: g, hits: snapshot.tabs.filter(t => t.groupId === g.id && saved.keys.includes(t.key)).length,
      })).filter(c => c.hits > 0).sort((a, b) => b.hits - a.hits);
      group = candidates[0]?.group;
      if (candidates[1]?.hits === candidates[0]?.hits) group = undefined;
    }
    if (!group || used.has(group.id)) {
      for (const key of saved.keys) if (snapshot.tabs.some(t => t.key === key && t.groupId === -1)) exclude(key);
      continue;
    }
    used.add(group.id);
    const members = snapshot.tabs.filter(t => t.groupId === group!.id);
    for (const key of saved.keys) {
      if (snapshot.tabs.some(t => t.key === key && t.groupId === -1)) exclude(key);
    }
    const corrected = group.title !== saved.title || group.color !== saved.color || members.some(t => !saved.keys.includes(t.key)) ||
      snapshot.tabs.some(t => saved.keys.includes(t.key) && t.groupId !== group!.id);
    result.push({ ...saved, origin: corrected ? 'user' : saved.origin, groupId: group.id, epoch: snapshot.epoch, title: group.title,
      color: group.color, keys: members.map(t => t.key), updatedAt: Date.now() });
  }
  memory.ignored = [...new Set(memory.ignored)];
  const tracked = referenceThreads(snapshot, result);
  // A closed/moved-away member makes the original combination impossible.
  // An explicit manual regroup takes precedence over older negative feedback.
  memory.rejectedGroups = memory.rejectedGroups?.filter(keys => keys.length >= 2 && keys.every(k => present.has(k)) &&
    !tracked.some(t => t.origin === 'user' && keys.every(k => t.keys.includes(k))));
  state.threads = [...state.threads.filter(t => t.windowKey !== snapshot.windowKey), ...tracked];
  return tracked;
}
export function labelInput(tabs: Tab[], all: Tab[]): { keywords: string[]; titles: string[] } {
  const generic = new Set('best top latest new online find explore exploring understanding using use buy shop watch join contact current discussion discussions forum forums community about among why what when where which did does tips guide guides year years season must-see must-watch most popular all different various general'.split(' '));
  const terms = (title: string) => [...new Set([...words(title.replace(/\b(\d{2,4})\(([a-z])\)/gi, '$1$2')), ...(title.match(/\b[A-Z][A-Z\d]{1,3}\b/g) ?? []).map(word => word.toLowerCase())])]
    .filter(word => !generic.has(word) && !stop.has(word) && /\p{L}/u.test(word));
  const df = new Map<string, number>();
  for (const tab of all) for (const word of new Set(terms(pageTitle(tab, true)))) df.set(word, (df.get(word) ?? 0) + 1);
  const counts = new Map<string, number>();
  const titles = [...new Set(tabs.map(tab => pageTitle(tab, true)))].sort();
  for (const title of titles) for (const word of new Set(terms(title))) counts.set(word, (counts.get(word) ?? 0) + 1);
  const weight = ([word, count]: [string, number]) => count * (1 + 0.15 * Math.log(1 + all.length / (df.get(word) ?? 1)));
  const keywords = [...counts].sort((a, b) => weight(b) - weight(a) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, 3).map(([word]) => word);
  // Representative content, not whichever three tabs happen to be leftmost.
  const support = (title: string) => [...new Set(terms(title))].filter(word => keywords.includes(word)).length;
  titles.sort((a, b) => support(b) - support(a) || (a < b ? -1 : a > b ? 1 : 0));
  return { keywords, titles: titles.slice(0, 3).map(title => title.slice(0, 160)) };
}
export function cleanLabel(label: string, keywords: string[], titles: string[] = []): string {
  // Identical short headlines already supply an exact, useful caption. Do
  // not let generation misspell a name or drop part of that sole subject.
  if (titles.length === 1) {
    const title = titles[0].replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (title && title.length <= 55 && title.split(/\s+/).length <= 4) return title.charAt(0).toUpperCase() + title.slice(1);
  }
  const cleaned = label.replace(/[\u0000-\u001f\u007f]/g, '').replace(/^[\s"'#*-]+|[\s"'.]+$/g, '').trim()
    .replace(/s[’']s\b/g, 's’')
    .split(/\s+/).filter((word, i, parts) => i === 0 || word.toLocaleLowerCase() !== parts[i - 1].toLocaleLowerCase()).join(' ');
  const tokens = (s: string): string[] => s.toLowerCase().replace(/\b(\d{2,4})\(([a-z])\)/g, '$1$2').match(/[\p{L}\p{N}]+/gu) ?? [];
  const vague = new Set('academic cultural historical social smart online various latest new world financial'.split(' '));
  const terms = tokens(cleaned).filter(word => !stop.has(word) && word.length > 1);
  const evidence = titles.flatMap(tokens);
  const compounds = titles.flatMap(title => { const parts = tokens(title); return parts.slice(1).map((word, i) => parts[i] + word); });
  const stem = (word: string) => word.replace(/(?:ings?|ers?|ed|es|s)$/, '').replace(/e$/, '');
  const related = (a: string, b: string) => a === b || (stem(a).length >= 3 && stem(a) === stem(b)) ||
    (a.length >= 4 && b.length >= 4 && a.slice(0, Math.min(5, a.length, b.length)) === b.slice(0, Math.min(5, a.length, b.length)));
  const supported = (word: string) => compounds.includes(word) || evidence.some(t => related(word, t));
  // Category words may summarize a subject without occurring verbatim, but
  // cannot justify an otherwise unsupported name.
  const categories = new Set('travel shopping research news technology banking finance education games health fitness software food history entertainment science'.split(' '));
  const anchored = terms.some(word => keywords.some(key => related(word, key)));
  const roots = terms.map(word => word.length >= 5 ? word.slice(0, 5) : word);
  const fallback = (expand = false) => {
    // Prefer a short, literal subject phrase to an invented name or a bag of
    // unrelated keywords. Only the already-minimized naming input is used.
    const excluded = new Set([...stop, 'best', 'top', 'latest', 'new', 'explore', 'exploring', 'understanding', 'using', 'why', 'what', 'did', 'does', 'year', 'years', 'most', 'popular', 'different', 'various', 'general']);
    const phrases = new Map<string, { text: string; count: number; hits: number; length: number }>();
    for (const title of titles) {
      const parts = title.match(/\d{2,4}\([a-z]\)|[\p{L}\p{N}]+(?:[’'][\p{L}]+)?/giu) ?? [];
      const seen = new Set<string>();
      for (let i = 0; i < parts.length; i++) for (let n = 2; n <= 4 && i + n <= parts.length; n++) {
        const part = parts.slice(i, i + n), lower = part.map(w => w.toLowerCase().replace(/(\d+)\(([a-z])\)/g, '$1$2'));
        if (excluded.has(lower[0]) || excluded.has(lower.at(-1)!) || lower.filter(w => !excluded.has(w)).length < 2) continue;
        const hits = lower.filter(w => keywords.includes(w)).length;
        if (!hits) continue;
        const key = lower.join(' '), text = part.join(' ');
        if (text.length > 55 || seen.has(key)) continue;
        seen.add(key);
        const saved = phrases.get(key);
        if (saved) saved.count++;
        else phrases.set(key, { text, count: 1, hits, length: n });
      }
    }
    const score = (p: { count: number; hits: number; length: number }) => p.count * 3 + p.hits - p.length * 0.6;
    const candidates = [...phrases.values()].filter(p => !expand || (p.length <= 3 && p.count >= Math.max(2, Math.ceil(titles.length * 2 / 3)) && tokens(p.text).includes(terms[0])));
    const best = candidates.sort((a, b) => score(b) - score(a) || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0))[0]?.text;
    const value = best || (expand ? cleaned : keywords.filter(w => !vague.has(w)).slice(0, 2).join(' ') || 'Related pages');
    return (value.charAt(0).toUpperCase() + value.slice(1)).slice(0, 55);
  };
  if (!cleaned || /^(none|unknown|adult content|miscellaneous|other|undefined|topic|tabs?)$/i.test(cleaned) || cleaned.length > 55 ||
    (terms.length === 1 && vague.has(terms[0])) || new Set(roots).size < roots.length ||
    (titles.length > 0 && terms.length > 0 && (!terms.some(supported) || terms.some(word => !supported(word) && !categories.has(word)) ||
      (keywords.length > 0 && terms.length === 1 && !anchored)))) return fallback();
  // Preserve complete, repeatedly supported subjects such as "Port Arthur"
  // or "False pregnancy", instead of accepting a misleading fragment.
  if (terms.length === 1 && titles.length > 1) return fallback(true);
  const generic = /^(webhooks?|documentation|development|shopping|travel|guides?|research|projects?|code|api|errors?)$/i.test(cleaned);
  const specific = keywords.find(w => !cleaned.toLocaleLowerCase().includes(w) && !/^(docs?|guide|travel|code|api|documentation)$/.test(w));
  if (generic && specific && titles.length) return fallback();
  const result = generic && specific ? specific + ' ' + cleaned.toLocaleLowerCase() : cleaned;
  return result.charAt(0).toUpperCase() + result.slice(1);
}
export async function fingerprint(snapshot: Snapshot, ignored: string[], links: AppState['links'], grouping: GroupingStyle = 'balanced', rejectedGroups: string[][] = []): Promise<string> {
  const value = JSON.stringify([
    grouping, rejectedGroups,
    snapshot.tabs.filter(t => eligible(t) && !ignored.includes(t.key))
      .map(t => [t.key, t.url, t.title.replace(/^\(\d+\)\s*/, ''), t.groupId]),
    snapshot.groups.map(g => [g.id, g.title]), ignored,
    links.filter(l => snapshot.tabs.some(t => t.key === l.a)).map(l => [l.a, l.b, Math.floor(l.weight / 3)]),
  ]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
