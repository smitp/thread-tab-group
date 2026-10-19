import { ThreadApp } from './core/app';
import { LocalIntelligence } from './ai/local';
import { HybridIntelligence } from './ai/hybrid';
import { FirefoxEmbeddings } from './platform/firefox/intelligence';
import { FirefoxPlatform } from './platform/firefox/browser';
import { FirefoxRepository } from './platform/firefox/storage';
import { dispatch } from './platform/requests';

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
      const value = await dispatch(app, message, async id => {
        const win = await browser.windows.get(id);
        if (win.incognito || win.type !== 'normal') throw new Error('Thread only works in normal, non-private windows.');
      });
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
