import { ThreadApp } from '../../core/app';
import { LocalRepository } from '../repository';
import { dispatch, type Request } from '../requests';
import { ChromePlatform } from './browser';
import { ChromeIntelligence } from './intelligence';
import { ChromeSession } from './session';

const session = new ChromeSession();
const platform = new ChromePlatform(session);
const ai = new ChromeIntelligence();
const ready = Promise.all([session.ready, ai.recover()]);
const repository = new LocalRepository(chrome.storage.local, ready);
let scheduled = false;
const notify = () => {
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    void chrome.runtime.sendMessage({ type: 'thread:changed' }).catch(() => undefined);
  }, 150);
};
const app = new ThreadApp(platform, repository, ai, notify);
// Commands surface initialization failures. Do not log raw tab/model inputs.
void app.ready.catch(() => undefined);

async function launch(run: () => Promise<void>) {
  await app.ready;
  if (!(await repository.read()).settings.onboarded) throw new Error('Complete the first-use setup first.');
  const end = await ai.begin();
  // Acknowledge now: the popup may close, and first downloads can outlive a
  // message channel. Progress and the journal report the final outcome.
  void run().finally(end).catch(() => notify());
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!message || typeof message !== 'object' || sender.id !== chrome.runtime.id) return false;
  if (sender.url === chrome.runtime.getURL('offscreen.html')) {
    if (message.target === 'thread:idle') void ready.then(() => ai.closeIdle(message.owner)).catch(() => undefined);
    // A message during active computation resets Chrome's idle timer. If the
    // worker was terminated anyway, ready resets the abandoned host first.
    if (message.target === 'thread:heartbeat') reply({ ok: true });
    return false;
  }
  if (message.target || message.type === 'thread:changed' || !sender.url?.startsWith(chrome.runtime.getURL(''))) return false;
  void (async () => {
    try {
      if (typeof message.type !== 'string') throw new Error('Invalid request.');
      const operation = () => dispatch(app, message as Request, async id => {
        const win = await chrome.windows.get(id);
        if (win.incognito || win.type !== 'normal') throw new Error('Thread only works in normal, non-Incognito windows.');
      }, launch);
      let value: unknown;
      if (['undo', 'reject', 'finish-rejection'].includes(message.type)) {
        await app.ready;
        const end = await ai.begin();
        try { value = await operation(); } finally { await end(); }
      } else value = await operation();
      reply({ ok: true, value });
    } catch (error) {
      reply({ ok: false, error: error instanceof Error ? error.message : 'Thread could not finish that action.' });
    }
  })();
  return true;
});
chrome.tabs.onActivated.addListener(info => {
  void (async () => {
    await app.ready;
    const state = await repository.read();
    if (!state.settings.onboarded || !state.settings.learn) return;
    const signal = await platform.signal(info.tabId);
    if (signal) await app.activity(signal.tab, signal.windowKey, signal.focused);
  })().catch(() => app.resetActivity());
});
chrome.windows.onFocusChanged.addListener(() => app.resetActivity());
chrome.tabs.onRemoved.addListener(id => {
  void session.forget(id).then(key => key ? app.forgetKey(key) : undefined).catch(() => undefined);
});
chrome.windows.onRemoved.addListener(id => {
  void session.forgetWindow(id).then(key => key ? repository.update(s => {
    delete s.windows[key]; s.threads = s.threads.filter(t => t.windowKey !== key);
  }) : undefined).catch(() => undefined);
});
