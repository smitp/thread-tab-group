import type { WindowMemory } from './types';

// Explicit feedback, not passive activity learning. Store opaque tab identities
// only. A rejected set forbids that whole combination (including supersets),
// not every pair within it: useful smaller groups must remain possible.
export function allowsGroup(keys: Iterable<string>, rejected: string[][] = []): boolean {
  if (!rejected.length) return true;
  const members = new Set(keys);
  return !rejected.some(group => group.length >= 2 && group.length <= members.size && group.every(key => members.has(key)));
}
export function rememberRejection(memory: WindowMemory, keys: string[]): void {
  const group = [...new Set(keys)].sort();
  if (group.length < 2) return;
  const signature = group.join('|');
  memory.rejectedGroups = [...(memory.rejectedGroups ?? []).filter(g => g.join('|') !== signature), group].slice(-50);
}
