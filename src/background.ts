import { ThreadApp } from './core/app';
import { LocalIntelligence } from './ai/local';
import { HybridIntelligence } from './ai/hybrid';
import { FirefoxEmbeddings } from './platform/firefox/intelligence';
import { FirefoxPlatform } from './platform/firefox/browser';
import { FirefoxRepository } from './platform/firefox/storage';

const platform = new FirefoxPlatform();
const repository = new FirefoxRepository();
let scheduled = false;
const notify = () => {
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    void browser.runtime.sendMessage({ type: 'thread:changed' }).catch(() => { /* Popup is closed. State remains in the background. */ });
  }, 150);
};
const app = new ThreadApp(platform, repository,
  new HybridIntelligence(new LocalIntelligence(browser.runtime.getURL('ai/worker.js')), new FirefoxEmbeddings()), notify);

browser.runtime.onMessage.addListener((message, sender) => {
  if (!message || typeof message !== 'object' || message.type === 'thread:changed') return false;
  if (sender.id !== browser.runtime.id || !sender.url?.startsWith(browser.runtime.getURL(''))) return false;
  return (async () => {
    try {
      if (typeof message.type !== 'string') throw new Error('Invalid request.');
      const id = message.windowId;
      if (message.type !== 'settings' && (!Number.isInteger(id) || id < 0)) throw new Error('No browser window selected.');
      if (Number.isInteger(id)) {
        const win = await browser.windows.get(id);
        if (win.incognito || win.type !== 'normal') throw new Error('Thread only works in normal, non-private windows.');
      }
      let value: unknown;
      switch (message.type) {
        case 'view': value = await app.view(id); break;
        case 'organize':
          if (message.grouping !== undefined && !['balanced', 'focused', 'broad'].includes(message.grouping)) throw new Error('Unknown grouping style.');
          await app.start(id, { retry: message.retry === true, grouping: message.grouping,
            retryUndone: message.retryUndone === true, includeExcluded: message.includeExcluded === true }); break;
        case 'cancel': app.cancel(); break;
        case 'undo': await app.undo(id); break;
        case 'reject':
          if (typeof message.threadId !== 'string') throw new Error('No group selected.');
          await app.reject(id, message.threadId); break;
        case 'finish-rejection': await app.reject(id); break;
        case 'resume':
          if (typeof message.threadId !== 'string') throw new Error('No thread selected.');
          await app.resume(id, message.threadId); break;
        case 'settings':
          if (typeof message.learn !== 'boolean') throw new Error('Invalid preference.');
          await app.settings(message.learn, message.onboard === true); break;
        case 'clear': await app.clearLearning(id, message.retryLoose === true); break;
        default: throw new Error('Unknown action.');
      }
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Thread could not finish that action.' };
    }
  })();
});

browser.tabs.onActivated.addListener(info => {
  void (async () => {
    await app.ready;
    const state = await repository.read();
    if (!state.settings.onboarded || !state.settings.learn) return;
    const signal = await platform.signal(info.tabId);
    if (signal) await app.activity(signal.tab, signal.windowKey, signal.focused);
  })().catch(() => app.resetActivity());
});
browser.windows.onFocusChanged.addListener(() => app.resetActivity());
browser.tabs.onRemoved.addListener(id => {
  const key = platform.knownKey(id);
  platform.forget(id);
  if (key) void key.then(k => app.forgetKey(k)).catch(() => undefined);
});
