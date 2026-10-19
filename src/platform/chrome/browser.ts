import type { GroupColor, GroupGuard, Platform, Snapshot, Tab } from '../../core/types';
import { ChromeSession } from './session';

type ChromeGroup = chrome.tabGroups.TabGroup & { shared?: boolean };
const protectedTab = (t: chrome.tabs.Tab) => !!(t.audible || t.frozen || (t.splitViewId !== undefined && t.splitViewId !== -1));
export class ChromePlatform implements Platform {
  readonly defaultGroupColor = 'grey' as const;
  constructor(readonly session: ChromeSession) {}
  private normalize(t: chrome.tabs.Tab, key: string, shared = false): Tab {
    return { id: t.id!, key, windowId: t.windowId, index: t.index, groupId: t.groupId ?? -1,
      container: 'chrome-default', title: t.title ?? '', url: t.url ?? '', active: t.active,
      pinned: t.pinned, hidden: false, busy: protectedTab(t) || shared,
      lastAccessed: t.lastAccessed ?? 0, openerId: t.openerTabId };
  }
  async snapshot(windowId: number): Promise<Snapshot> {
    if (!chrome.tabs.group || !chrome.tabs.ungroup || !chrome.tabGroups?.query || !chrome.tabGroups?.update || !chrome.offscreen?.createDocument) {
      throw new Error('Thread needs desktop Chrome 121 or newer with native tab groups and offscreen documents enabled.');
    }
    const win = await chrome.windows.get(windowId);
    if (win.incognito || win.type !== 'normal') throw new Error('Thread only organizes normal, non-Incognito browser windows.');
    const [raw, groups] = await Promise.all([chrome.tabs.query({ windowId }), chrome.tabGroups.query({ windowId })]);
    const present = raw.filter(t => t.id !== undefined && !t.incognito).sort((a, b) => a.index - b.index);
    const ids = await this.session.identify(present.map(t => t.id!), windowId);
    const shared = new Set((groups as ChromeGroup[]).filter(g => g.shared).map(g => g.id));
    return { windowId, windowKey: ids.windowKey, epoch: ids.epoch,
      tabs: present.map((t, i) => this.normalize(t, ids.keys[i], shared.has(t.groupId))),
      groups: (groups as ChromeGroup[]).map(g => ({ id: g.id, title: g.title ?? '', color: g.color as GroupColor,
        collapsed: g.collapsed, protected: !!g.shared })) };
  }
  async group(windowId: number, tabIds: number[], existingGroup?: number): Promise<number> {
    if (!tabIds.length) throw new Error('No tabs selected.');
    const selected: [number, ...number[]] = [tabIds[0], ...tabIds.slice(1)];
    const tabs = await Promise.all(tabIds.map(id => chrome.tabs.get(id)));
    if (tabs.some(t => t.windowId !== windowId || t.incognito || t.pinned || protectedTab(t) || t.groupId !== -1)) {
      throw new Error('Some tabs changed while organizing. They were left alone.');
    }
    if (existingGroup !== undefined) {
      const group = await chrome.tabGroups.get(existingGroup) as ChromeGroup;
      if (group.windowId !== windowId || group.shared) throw new Error('This group changed or is shared. It was left alone.');
    }
    return chrome.tabs.group(existingGroup === undefined ? { tabIds: selected, createProperties: { windowId } } : { tabIds: selected, groupId: existingGroup });
  }
  async styleGroup(id: number, title: string, color: GroupColor, collapsed: boolean) {
    if ((await chrome.tabGroups.get(id) as ChromeGroup).shared) throw new Error('Shared groups are protected.');
    if (collapsed) collapsed = !(await chrome.tabs.query({ groupId: id })).some(t => t.active);
    await chrome.tabGroups.update(id, { title, color, collapsed });
  }
  private async matches(expected: GroupGuard): Promise<boolean> {
    const [group, members] = await Promise.all([chrome.tabGroups.get(expected.groupId) as Promise<ChromeGroup>,
      chrome.tabs.query({ groupId: expected.groupId })]);
    return !group.shared && group.windowId === expected.windowId && (group.title ?? '') === expected.title && group.color === expected.color &&
      (expected.collapsed === undefined || group.collapsed === expected.collapsed) && !!expected.memberIds &&
      members.sort((a, b) => a.index - b.index).map(t => t.id).join('|') === expected.memberIds.join('|');
  }
  async setCollapsed(collapsed: boolean, expected: GroupGuard): Promise<boolean> {
    if (!await this.matches(expected)) return false;
    if (collapsed && (await chrome.tabs.query({ groupId: expected.groupId })).some(t => t.active)) return false;
    // Change only collapse, never replay a stale title/color over a correction.
    await chrome.tabGroups.update(expected.groupId, { collapsed });
    return true;
  }
  async ungroup(ids: number[], expected: GroupGuard): Promise<boolean> {
    if (!ids.length) return true;
    if (expected.groupId !== -1 && !await this.matches(expected)) return false;
    // Last check has no intervening session/storage writes. Never detach a tab
    // now belonging to another manual group, a split view, or an active player.
    const tabs = await Promise.all(ids.map(id => chrome.tabs.get(id)));
    if (tabs.some(t => t.windowId !== expected.windowId || t.incognito || t.groupId !== expected.groupId || t.pinned || protectedTab(t))) return false;
    if (expected.groupId !== -1) await chrome.tabs.ungroup([ids[0], ...ids.slice(1)]);
    return true;
  }
  async move(id: number, index: number, windowId: number) {
    const tab = await chrome.tabs.get(id);
    if (tab.windowId !== windowId || tab.incognito || tab.groupId !== -1 || tab.pinned || protectedTab(tab)) throw new Error('This tab changed during Undo. It was left in place.');
    await chrome.tabs.move(id, { index });
  }
  async activate(tabId: number, groupId: number) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.incognito || tab.groupId !== groupId) throw new Error('This group has changed. Reopen Thread to refresh it.');
    await chrome.tabGroups.update(groupId, { collapsed: false });
    await chrome.tabs.update(tabId, { active: true });
  }
  async signal(tabId: number): Promise<{ tab: Tab; windowKey: string; focused: boolean } | undefined> {
    const t = await chrome.tabs.get(tabId);
    if (t.incognito) return;
    const windowKey = await this.session.windowKey(t.windowId);
    if (!windowKey) return;
    const win = await chrome.windows.get(t.windowId);
    if (win.type !== 'normal') return;
    const key = (await this.session.identify([tabId], t.windowId)).keys[0];
    return { tab: this.normalize(t, key), windowKey, focused: win.focused };
  }
}
