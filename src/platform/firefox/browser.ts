import type { GroupColor, Platform, Snapshot, Tab } from '../../core/types';

const TAB_KEY = 'thread.tab.v1';
const WINDOW_KEY = 'thread.window.v1';
export class FirefoxPlatform implements Platform {
  private keys = new Map<number, Promise<string>>();
  private epochPromise = (async () => {
    const stored = (await browser.storage.session.get('threadEpoch')).threadEpoch;
    if (stored) return stored as string;
    const epoch = crypto.randomUUID();
    await browser.storage.session.set({ threadEpoch: epoch });
    return epoch;
  })();
  private tabKey(id: number): Promise<string> {
    if (!this.keys.has(id)) this.keys.set(id, (async () => {
      const stored = await browser.sessions.getTabValue(id, TAB_KEY);
      if (typeof stored === 'string') return stored;
      const key = crypto.randomUUID();
      await browser.sessions.setTabValue(id, TAB_KEY, key);
      return key;
    })());
    return this.keys.get(id)!;
  }
  knownKey(id: number) { return this.keys.get(id); }
  forget(id: number) { this.keys.delete(id); }
  private normalize(t: browser.tabs.Tab, key: string): Tab {
    return {
      id: t.id!, key, windowId: t.windowId!, index: t.index, groupId: t.groupId ?? -1,
      container: t.cookieStoreId ?? 'unknown:' + t.id, title: t.title ?? '', url: t.url ?? '',
      active: t.active, pinned: t.pinned, hidden: t.hidden ?? false,
      busy: !!(t.audible || t.sharingState?.camera || t.sharingState?.microphone || t.sharingState?.screen),
      lastAccessed: t.lastAccessed ?? 0, openerId: t.openerTabId,
    };
  }
  async snapshot(windowId: number): Promise<Snapshot> {
    if (!browser.tabs.group || !browser.tabs.ungroup || !browser.tabGroups?.query || !browser.tabGroups?.update) {
      throw new Error('Thread needs desktop Firefox 140 or newer with native tab groups enabled. Firefox AI is not required.');
    }
    const win = await browser.windows.get(windowId);
    if (win.incognito || win.type !== 'normal') throw new Error('Thread only organizes normal, non-private browser windows.');
    let windowKey = await browser.sessions.getWindowValue(windowId, WINDOW_KEY);
    if (typeof windowKey !== 'string') {
      windowKey = crypto.randomUUID();
      await browser.sessions.setWindowValue(windowId, WINDOW_KEY, windowKey);
    }
    const [rawTabs, groups, epoch] = await Promise.all([
      browser.tabs.query({ windowId }), browser.tabGroups.query({ windowId }), this.epochPromise,
    ]);
    const tabs: Tab[] = [];
    const seen = new Set<string>();
    for (const tab of rawTabs) {
      if (tab.id === undefined || tab.incognito) continue;
      try {
        let key = await this.tabKey(tab.id);
        // Duplicating/restoring a tab can copy its extension session data.
        if (seen.has(key)) {
          key = crypto.randomUUID(); await browser.sessions.setTabValue(tab.id, TAB_KEY, key);
          this.keys.set(tab.id, Promise.resolve(key));
        }
        seen.add(key); tabs.push(this.normalize(tab, key));
      } catch { /* A tab closed while taking the snapshot. */ }
    }
    return { windowId, windowKey: windowKey as string, epoch, tabs,
      groups: groups.map(g => ({ id: g.id, title: g.title ?? '', color: g.color as GroupColor, collapsed: g.collapsed })) };
  }
  async group(windowId: number, tabIds: number[], existingGroup?: number) {
    // Recheck after the recovery journal was written, immediately before mutation.
    const tabs = await Promise.all(tabIds.map(id => browser.tabs.get(id)));
    if (tabs.some(t => t.windowId !== windowId || t.incognito || t.pinned || t.hidden || t.audible ||
      (t.groupId ?? -1) !== -1 || t.sharingState?.camera || t.sharingState?.microphone || t.sharingState?.screen) ||
      new Set(tabs.map(t => t.cookieStoreId)).size !== 1) throw new Error('Some tabs changed while organizing. They were left alone.');
    return browser.tabs.group(existingGroup === undefined ? { tabIds, createProperties: { windowId } } : { tabIds, groupId: existingGroup });
  }
  async styleGroup(id: number, title: string, color: GroupColor, collapsed: boolean) {
    if (collapsed) collapsed = !(await browser.tabs.query({ groupId: id })).some(t => t.active);
    await browser.tabGroups.update(id, { title, color, collapsed });
  }
  async ungroup(ids: number[]) { if (ids.length) await browser.tabs.ungroup(ids); }
  async move(id: number, index: number) { await browser.tabs.move(id, { index }); }
  async activate(tabId: number, groupId: number) {
    const tab = await browser.tabs.get(tabId);
    if (tab.incognito) throw new Error('Private tabs are not available.');
    if (tab.groupId !== groupId) throw new Error('This thread has changed. Reopen Thread to refresh it.');
    await browser.tabGroups.update(groupId, { collapsed: false });
    await browser.tabs.update(tabId, { active: true });
  }
  async signal(tabId: number): Promise<{ tab: Tab; windowKey: string; focused: boolean } | undefined> {
    const t = await browser.tabs.get(tabId);
    if (t.incognito || t.windowId === undefined) return;
    const windowKey = await browser.sessions.getWindowValue(t.windowId, WINDOW_KEY);
    if (typeof windowKey !== 'string') return;
    const win = await browser.windows.get(t.windowId);
    if (win.type !== 'normal') return;
    return { tab: this.normalize(t, await this.tabKey(tabId)), windowKey, focused: win.focused };
  }
}
