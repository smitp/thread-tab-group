import type { GroupingStyle, Intelligence, Link, PlanGroup, Progress, Snapshot, Tab, Thread } from './types';
import { eligible, pageTitle, sharedTool, titleText, words } from './tabs';
import { allowsGroup } from './rejections';
import { acceptsSemantic, groupPreferences, preferenceMatch } from './preferences';

function cosine(a: number[], b: number[]): number {
  let v = 0; for (let i = 0; i < a.length; i++) v += a[i] * b[i];
  return v;
}
// Granularity changes only new groups. Existing-group preference thresholds,
// container boundaries, ambiguous matches, and protected tabs remain unchanged.
const granularity = {
  balanced: { seed: 0.59, grow: 0.56, floor: 0.36, merge: 0.58, mergeFloor: 0.38 },
  focused: { seed: 0.69, grow: 0.65, floor: 0.48, merge: 0.67, mergeFloor: 0.50 },
  broad: { seed: 0.53, grow: 0.50, floor: 0.34, merge: 0.52, mergeFloor: 0.36 },
};
function check(signal: AbortSignal) { if (signal.aborted) throw new DOMException('Cancelled', 'AbortError'); }

export async function plan(
  snapshot: Snapshot, threads: Thread[], ignored: string[], links: Link[],
  ai: Intelligence, signal: AbortSignal, progress: (p: Progress) => void, grouping: GroupingStyle = 'balanced', rejectedGroups: string[][] = [],
): Promise<PlanGroup[]> {
  check(signal);
  const thresholds = granularity[grouping];
  const preferences = groupPreferences(snapshot, threads);
  // A tab's position affects presentation, never semantic tie-breaking or
  // inference batches. Opaque identities distinguish otherwise identical tabs.
  const order = (a: Tab, b: Tab) => {
    for (const field of ['container', 'url', 'title', 'key'] as const) {
      if (a[field] !== b[field]) return a[field] < b[field] ? -1 : 1;
    }
    return 0;
  };
  const ordered = [...snapshot.tabs].sort(order);
  const assignments = new Map<string, string[]>();
  const domainFallbacks = new Map<string, string>();
  const assign = (id: string, key: string): boolean => {
    const groupId = threads.find(t => t.id === id)?.groupId;
    const members = snapshot.tabs.filter(t => t.groupId === groupId).map(t => t.key);
    const keys = [...(assignments.get(id) ?? []), key];
    if (!allowsGroup([...members, ...keys], rejectedGroups)) return false;
    assignments.set(id, keys);
    return true;
  };
  const candidates: Tab[] = [];
  for (const tab of ordered.filter(t => t.groupId === -1 && eligible(t) && !ignored.includes(t.key))) {
    const matches = preferences.map(p => ({ p, score: preferenceMatch(tab, p) })).filter(m => m.score > 0)
      .sort((a, b) => b.score - a.score);
    if (matches[0]) {
      // Specific repository/path scopes beat a broad domain rule. Equally good
      // competing groups mean abstention, not a third duplicate group.
      if (!matches[1] || matches[0].score > matches[1].score) {
        const id = matches[0].p.thread.id;
        const host = new URL(tab.url).hostname.replace(/^www\./, '');
        const competingProject = matches[0].score === 10 && preferences.some(p => p.thread.id !== id &&
          p.thread.origin === 'user' && !p.domain && acceptsSemantic(tab, p) &&
          p.members.some(t => new URL(t.url).hostname.replace(/^www\./, '') === host));
        if (competingProject && !sharedTool(tab)) {
          // A mixed-site project can contain this repository without enough URL
          // examples to infer a path rule. Give its semantic evidence a chance
          // before falling back to the user's broad site group.
          domainFallbacks.set(tab.key, id);
          candidates.push(tab);
        } else if (!assign(id, tab.key) && !sharedTool(tab)) candidates.push(tab);
      }
    } else if (!sharedTool(tab)) candidates.push(tab);
  }
  const existingGroups = (): PlanGroup[] => [...assignments].map(([threadId, keys]) => ({ threadId, keys }));
  const references = preferences.flatMap(p => p.members).sort(order);
  if (!candidates.length || (candidates.length < 2 && references.length === 0)) return existingGroups();
  const tabs = [...candidates, ...references];
  const named = preferences.filter(p => p.thread.origin === 'user' && words(p.thread.title).length > 0);
  // Titles, minimized addresses, and user group names only; never page contents.
  const vectors = await ai.embed([...tabs.map(titleText), ...named.map(p => p.thread.title.slice(0, 160))], signal, progress);
  const nameVectors = new Map(named.map((p, i) => [p.thread.id, vectors[tabs.length + i]]));
  check(signal);
  progress({ stage: 'Matching tab groups', detail: 'Comparing related tabs with your existing groups and preferences.' });
  const index = new Map(tabs.map((t, i) => [t.key, i]));
  const tokens = tabs.map(t => new Set(words(pageTitle(t))));
  const boilerplate = new Set('best top latest new online buy shop guide guides tutorial tutorials review reviews tips introduction overview understanding using use learn learning forum forums discussion discussions example examples code error issue'.split(' '));
  // A light plural normalization keeps "retirement plan/plans" evidence from
  // disappearing. It is corroboration, never a substitute for semantic support.
  const subject = (word: string) => word.length > 4 && /s$/.test(word) && !/(ss|us|is)$/.test(word) ? word.slice(0, -1) : word;
  const subjects = tokens.map(set => new Set([...set].filter(word => !boilerplate.has(word)).map(subject)));
  const weights = new Map<string, number>();
  const degree = new Map<string, number>();
  for (const link of links) {
    weights.set([link.a, link.b].sort().join('|'), link.weight * Math.exp(-(Date.now() - link.at) / (3 * 86400000)));
    degree.set(link.a, (degree.get(link.a) ?? 0) + 1);
    degree.set(link.b, (degree.get(link.b) ?? 0) + 1);
  }
  function related(a: Tab, b: Tab, newGroup = false): number {
    if (a.container !== b.container) return -1;
    const i = index.get(a.key)!, j = index.get(b.key)!;
    const semantic = cosine(vectors[i], vectors[j]);
    const overlap = [...tokens[i]].filter(w => tokens[j].has(w)).length;
    const weight = weights.get([a.key, b.key].sort().join('|')) ?? 0;
    const hub = Math.max(degree.get(a.key) ?? 0, degree.get(b.key) ?? 0) > Math.max(5, tabs.length * 0.15);
    const behavior = hub ? 0 : Math.min(0.18, weight * 0.035);
    const opener = a.openerId === b.id || b.openerId === a.id ? 0.07 : 0;
    // Context can support weak semantic evidence; mere proximity/domain is not enough.
    if (semantic < 0.30 && behavior < 0.14) return 0;
    const shared = [...subjects[i]].filter(word => subjects[j].has(word)).length;
    // Multiple content words can corroborate a moderately similar subject.
    // Generic "best / guide / review" terms are excluded; recognized publisher
    // attribution is removed upstream. This extra evidence is limited to new
    // groups, not existing-group admission.
    const lexical = newGroup && semantic >= 0.40 && shared >= 2 ? Math.min(0.12, shared * 0.04) : Math.min(0.04, overlap * 0.015);
    return semantic + behavior + opener + lexical;
  }
  const loose: Tab[] = [];
  for (const tab of candidates) {
    check(signal);
    const fallback = domainFallbacks.get(tab.key);
    const matches = preferences.filter(p => acceptsSemantic(tab, p) &&
      (!fallback || (p.thread.origin === 'user' && p.thread.id !== fallback))).map(p => {
      const scores = p.members.map(t => related(tab, t)).sort((a, b) => b - a).slice(0, 3);
      const name = nameVectors.get(p.thread.id);
      const nameSupport = name ? Math.min(0.06, Math.max(0, cosine(vectors[index.get(tab.key)!], name) - 0.35) * 0.12) : 0;
      return { thread: p.thread, score: scores.reduce((a, b) => a + b, 0) / scores.length + nameSupport };
    }).sort((a, b) => b.score - a.score);
    const threshold = matches[0]?.thread.origin === 'user' ? 0.66 : 0.62;
    if (matches[0]?.score >= threshold) {
      if (!matches[1] || matches[0].score - matches[1].score >= 0.07) {
        const id = matches[0].thread.id;
        if (!assign(id, tab.key)) loose.push(tab);
      }
      // Ambiguous existing-group matches stay loose, even if they could seed a
      // new group together. Preserve the user's competing categories.
    } else if (!fallback || !assign(fallback, tab.key)) loose.push(tab);
  }
  // Best-first average linkage: let a strong topic grow before manufacturing
  // every possible disjoint seed pair. Keep minimum-pair/ambiguity safeguards,
  // so a shared hub cannot chain unrelated subjects into one group.
  const n = loose.length;
  const clusters = loose.map(tab => [tab]);
  const active = new Set(clusters.map((_, i) => i));
  const generation = new Uint32Array(n);
  const average = Array.from({ length: n }, () => new Float64Array(n));
  const minimum = Array.from({ length: n }, () => new Float64Array(n));
  type Edge = { a: number; b: number; score: number; ga: number; gb: number };
  const heap: Edge[] = [];
  const better = (x: Edge, y: Edge) => x.score > y.score || (x.score === y.score && (x.a < y.a || (x.a === y.a && x.b < y.b)));
  const push = (edge: Edge) => {
    let i = heap.length; heap.push(edge);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!better(edge, heap[parent])) break;
      heap[i] = heap[parent]; i = parent;
    }
    heap[i] = edge;
  };
  const pop = (): Edge => {
    const first = heap[0], last = heap.pop()!;
    if (heap.length) {
      let i = 0;
      while (i * 2 + 1 < heap.length) {
        let child = i * 2 + 1;
        if (child + 1 < heap.length && better(heap[child + 1], heap[child])) child++;
        if (!better(heap[child], last)) break;
        heap[i] = heap[child]; i = child;
      }
      heap[i] = last;
    }
    return first;
  };
  const compatible = (a: number, b: number) => {
    const singleA = clusters[a].length === 1, singleB = clusters[b].length === 1;
    const threshold = singleA && singleB ? thresholds.seed : singleA || singleB ? thresholds.grow : thresholds.merge;
    const floor = singleA && singleB ? thresholds.seed : singleA || singleB ? thresholds.floor : thresholds.mergeFloor;
    return average[a][b] >= threshold && minimum[a][b] >= floor &&
      (!rejectedGroups.length || allowsGroup([...clusters[a], ...clusters[b]].map(t => t.key), rejectedGroups));
  };
  const queue = (a: number, b: number) => {
    if (a > b) [a, b] = [b, a];
    if (compatible(a, b)) push({ a, b, score: average[a][b], ga: generation[a], gb: generation[b] });
  };
  for (let a = 0; a < n; a++) {
    if (a % 20 === 0) { await new Promise(r => setTimeout(r, 0)); check(signal); }
    for (let b = a + 1; b < n; b++) {
      average[a][b] = average[b][a] = minimum[a][b] = minimum[b][a] = related(loose[a], loose[b], true);
      queue(a, b);
    }
  }
  const valid = (edge: Edge) => active.has(edge.a) && active.has(edge.b) &&
    edge.ga === generation[edge.a] && edge.gb === generation[edge.b];
  const ambiguous = ({ a, b, score }: Edge) => {
    const single = clusters[a].length === 1 ? a : clusters[b].length === 1 ? b : undefined;
    return single !== undefined && clusters[a].length + clusters[b].length > 2 && [...active].some(k =>
      k !== a && k !== b && clusters[k].length > 1 && compatible(single, k) && score - average[single][k] < 0.06);
  };
  let steps = 0;
  let yieldedAt = Date.now();
  let deferred: Edge[] = [];
  while (heap.length || deferred.length) {
    if (!heap.length) {
      // Two competing fragments may since have joined the same topic. Recheck
      // abstentions without weakening the ambiguity margin or looping forever.
      for (const edge of deferred) if (valid(edge) && !ambiguous(edge)) push(edge);
      deferred = [];
      if (!heap.length) break;
    }
    if (steps++ % 128 === 0 && Date.now() - yieldedAt >= 16) {
      await new Promise(r => setTimeout(r, 0)); check(signal); yieldedAt = Date.now();
    }
    const edge = pop(), { a, b } = edge;
    if (!valid(edge)) continue;
    if (ambiguous(edge)) { deferred.push(edge); continue; }
    const sizeA = clusters[a].length, sizeB = clusters[b].length;
    for (const k of active) if (k !== a && k !== b) {
      average[a][k] = average[k][a] = (average[a][k] * sizeA + average[b][k] * sizeB) / (sizeA + sizeB);
      minimum[a][k] = minimum[k][a] = Math.min(minimum[a][k], minimum[b][k]);
    }
    clusters[a].push(...clusters[b]); clusters[b] = [];
    active.delete(b); generation[a]++;
    for (const k of active) if (k !== a) queue(a, k);
  }
  const groups = existingGroups();
  groups.push(...[...active].filter(i => clusters[i].length > 1).map(i => ({
    keys: clusters[i].sort((a, b) => a.index - b.index).map(t => t.key),
  })));
  return groups;
}
