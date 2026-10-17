import type { GroupingStyle, View } from '../core/types';
import { client, type NativeAccess } from '../platform/firefox/client';

const root = document.querySelector<HTMLDivElement>('#app')!;
let windowId: number;
let view: View | undefined;
let settingsOpen = false;
let error = '';
let submitting = false;
let refreshPending = false;
let refreshAgain = false;
let autoStarted = false;
let nativeAccess: NativeAccess = 'unavailable';
let nativeNote = '';
let groupingChoice: GroupingStyle | undefined;
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const tabCount = (n: number, kind = '') => n + ' ' + kind + (n === 1 ? 'tab' : 'tabs');
const busy = () => !!view?.progress || !!view?.otherWindowBusy || submitting;

function nativeControl() {
  const note = nativeNote || (nativeAccess === 'allowed'
    ? 'Firefox AI permission is enabled. The local fallback remains available. You can revoke permission in Firefox’s extension settings.'
    : nativeAccess === 'unavailable' ? 'Firefox AI is unavailable in this Firefox/add-on configuration. The bundled local AI is available without it.' : '');
  return (nativeAccess === 'available' ? '<button id="native-ai"' + (busy() ? ' disabled' : '') + '>Enable Firefox AI (optional)</button>' : '') +
    (note ? '<p class="setting-note" role="status">' + escape(note) + '</p>' : '');
}
function header() {
  const title = settingsOpen ? 'Settings' : view?.settings.onboarded === false ? 'Organize tabs' : 'Tab groups';
  return '<header><div class="panel-heading">' +
    (settingsOpen ? '<button class="toolbar-button" id="settings" aria-label="Back to tab groups">Back</button>' : '') +
    '<h1>' + title + '</h1></div>' +
    (view?.settings.onboarded && !settingsOpen ? '<button class="toolbar-button" id="settings">Settings</button>' : '') + '</header>';
}
function render() {
  const focused = document.activeElement?.id;
  const privacyOpen = document.querySelector('#privacy')?.hasAttribute('open');
  let content = '';
  if (!view) content = '<main><p class="secondary-text" role="status">' + (error ? 'Tab groups could not be loaded.' : 'Loading tab groups…') + '</p></main>';
  else if (!view.settings.onboarded) {
    content = '<main class="welcome">' +
      '<p>Organize related tabs in this window using on-device AI. Your existing groups guide new matches. No tabs are closed, and changes can be undone.</p>' +
      '<p class="disclosure">Firefox’s AI is optional. When unavailable, the same local model runs inside the extension. No account or cloud AI is needed.</p>' +
      '<p class="disclosure">The first run may download about 85 MB of models from Mozilla and Hugging Face, plus Firefox’s runtime. They receive model requests, not your tabs.</p>' +
      '<p class="disclosure">Titles, group names, and addresses are processed locally. Page contents and browsing history aren’t read.</p>' +
      '<label class="check-row"><input id="learn-optin" type="checkbox"><span><strong>Learn from tab activity</strong><small>Optional. Store local tab connections for up to 7 days. Clear them at any time.</small></span></label>' +
      '<div class="actions"><button id="onboard" class="primary"' + (submitting ? ' disabled' : '') + '>Organize tabs</button>' + nativeControl() + '</div></main>';
  } else if (settingsOpen) {
    content = '<main class="settings"><section class="settings-section"><h2>Activity learning</h2>' +
      '<label class="check-row"><input id="learning" type="checkbox"' + (view.settings.learn ? ' checked' : '') + (busy() ? ' disabled' : '') +
      '><span><strong>Learn from tab activity</strong><small>Keep up to 500 local tab connections for 7 days. No activity timeline or automatic rearranging.</small></span></label>' +
      '<button id="clear" class="setting-action"' + (busy() ? ' disabled' : '') + '><span>Clear learned connections<small>Keep groups and manual corrections.</small></span></button></section>' +

      '<section class="settings-section"><h2>On-device AI</h2><p class="setting-note">Prefer Firefox’s runtime when available. Otherwise, use the bundled local runtime with the same model. No Nightly requirement or cloud fallback.</p>' +
      nativeControl() + '</section>' +
      '<details id="privacy"' + (privacyOpen ? ' open' : '') + '><summary>Privacy and data</summary><p>Titles, group names, and addresses stay on this device. No page contents, cookies, closed-tab history, or private windows are read. Thread sends no analytics. Firefox’s native runtime follows Firefox’s own diagnostic settings.</p>' +
      '<p>Existing groups guide new matches even with activity learning off. Preferences are inferred from open tabs, not a stored browsing profile. Group identities, membership, corrections, and Undo are kept locally. Rejected combinations use only opaque tab identities, with up to 50 remembered per window. Closing a member or manually regrouping the combination clears that feedback when observed.</p>' +
      '<p>Firefox’s session permission provides stable tab identities. The optional AI permission can be declined or revoked without disabling the bundled local runtime.</p></details>' +
      '<p class="extension-note">Thread · On-device tab organization</p></main>';
  } else {
    const progress = view.progress;
    content = '<main><div class="scope-row"><span>This window</span><span>' + tabCount(view.total) + '</span></div>';
    if (progress) {
      content += '<section class="progress" role="status" aria-live="polite"><strong>' + escape(progress.stage) + '</strong><p>' + escape(progress.detail) +
        '</p><progress max="100"' + (progress.percent !== undefined ? ' value="' + Math.max(0, Math.min(100, progress.percent)) + '"' : '') + ' aria-label="' + escape(progress.stage) + '"></progress>' +
        (view.canCancel ? '<button id="cancel">Cancel organization</button>' : '') + '</section>';
    } else if (view.otherWindowBusy) content += '<p class="notice" role="status">Organizing another window.</p>';
    else if (view.receipt) content += '<p class="receipt ' + (view.receipt.kind === 'error' ? 'is-error' : '') + '" role="status">' + escape(view.receipt.message) + '</p>';
    if (view.threads.length) {
      content += '<div class="thread-list" role="group" aria-label="Tab groups">';
      for (const thread of view.threads) {
        const color = ['blue','purple','cyan','orange','green','pink','red','yellow','grey'].includes(thread.color) ? thread.color : 'grey';
        const description = 'Open ' + thread.title + ', ' + thread.count + ' tabs. Continue with ' + thread.lastTitle;
        content += '<div class="thread-entry"><button class="thread-row color-' + color + '" data-thread="' + escape(thread.id) + '" aria-label="' + escape(description) + '"' +
          (thread.active ? ' aria-current="true"' : '') + (busy() ? ' disabled' : '') + '><span class="thread-mark" aria-hidden="true"></span><span class="thread-copy"><span class="thread-title">' +
          escape(thread.title) + '</span><span class="last-page">' + escape(thread.lastTitle) + '</span></span><span class="count" aria-hidden="true">' + thread.count + '</span></button>' +
          (thread.canReject ? '<button class="reject-group" id="reject-' + escape(thread.id) + '" data-reject="' + escape(thread.id) +
            '" aria-label="' + escape('Reject ' + thread.title + '; keep its tabs open') + '" title="Ungroup these tabs and reconsider them on the next run"' +
            (busy() ? ' disabled' : '') + '>Reject</button>' : '') + '</div>';
      }
      content += '</div>';
    } else if (!progress && !view.otherWindowBusy && !view.receipt) content += '<p class="empty">' +
      (view.total < 2 ? 'Open a few related pages to organize this window.' : 'No groups yet. Tabs with uncertain connections will stay ungrouped.') + '</p>';
    const ready = !progress && !view.otherWindowBusy;
    const canRun = view.available + view.retryCount > 0;
    const disabled = busy() || view.receipt?.needsRecovery || view.canRecoverRejection;
    if (ready && view.loose > 0) {
      content += '<div class="grouping-control"><label for="grouping">Grouping style</label><select id="grouping"' + (busy() ? ' disabled' : '') + '>' +
        (['balanced', 'focused', 'broad'] as const).map(style => '<option value="' + style + '"' + ((groupingChoice ?? view!.grouping) === style ? ' selected' : '') + '>' +
          ({ balanced: 'Balanced', focused: 'More focused', broad: 'Broader' }[style]) + '</option>').join('') + '</select></div>';
      content += '<p class="setting-note">Grouping style affects new groups only. Existing groups stay in place.</p>';
      if (view.retryCount) content += '<p class="loose-note">The next run includes ' + tabCount(view.retryCount) + ' restored by Undo. Other exclusions stay protected.</p>';
      else if (view.available) content += '<p class="loose-note">' + tabCount(view.available, 'ungrouped ') + ' available to organize.</p>';
      if (view.retryCount && view.excluded > view.retryCount) content += '<p class="loose-note">' + tabCount(view.excluded - view.retryCount) + ' left out by your earlier choices.</p>';
    }
    if (ready && view.canUndo) content += '<p class="setting-note feedback-hint">' + (view.threads.some(t => t.canReject)
      ? 'Keep the useful groups. Reject an unwanted group, then organize the ungrouped tabs again.'
      : 'Use Undo for the last run, or move tabs with Firefox’s own controls.') + '</p>';
    else if (ready && !view.loose) content += '<p class="setting-note feedback-hint">Pinned, hidden, and playing/sharing tabs are always protected.</p>';
    content += '<div class="actions">' +
      (ready && view.canRecoverRejection ? '<button id="finish-rejection" class="primary"' + (busy() ? ' disabled' : '') + '>Finish rejection</button>' : '') +
      (view.canUndo ? '<button id="undo"' + (busy() ? ' disabled' : '') + '>Undo</button>' : '') +
      (ready && canRun && !view.canRecoverRejection ? '<button id="organize" class="primary"' + (disabled ? ' disabled' : '') + '>' +
        (view.regroupCount ? 'Organize ungrouped tabs' : view.retryCount ? 'Organize again' : view.receipt?.kind === 'error' ? 'Try again' : view.threads.length ? 'Organize ungrouped tabs' : 'Organize tabs') + '</button>' : '') + '</div>' +
      (ready && !view.canRecoverRejection && view.excluded > view.retryCount ? '<div class="excluded-action"><button id="reconsider"' + (!canRun ? ' class="primary"' : '') + (disabled ? ' disabled' : '') +
        '>Include ' + tabCount(view.excluded, 'excluded ') + '</button><small>Also reconsider tabs you manually ungrouped.</small></div>' : '') + '</main>';
    content += '<footer><span>On-device processing</span><span>Tabs stay open</span></footer>';
  }
  root.innerHTML = header() + content + ((error || view?.error) ? '<div class="error-banner" role="alert">' + escape(error || view?.error || '') + '</div>' : '');
  if (focused) document.getElementById(focused)?.focus({ preventScroll: true });
  bind();
}
async function refresh() {
  if (windowId === undefined) return;
  if (refreshPending) { refreshAgain = true; return; }
  refreshPending = true;
  try {
    view = await client.send<View>('view', windowId);
    render();
  } catch (e) { error = e instanceof Error ? e.message : 'Could not connect to Thread.'; render(); }
  finally {
    refreshPending = false;
    if (refreshAgain) { refreshAgain = false; void refresh(); }
  }
}
async function act(action: () => Promise<void>) {
  if (submitting) return;
  submitting = true; error = ''; render();
  try { await action(); }
  catch (e) { error = e instanceof Error ? e.message : 'That action could not finish.'; }
  finally { submitting = false; await refresh(); }
}
function click(id: string, fn: () => void) { document.getElementById(id)?.addEventListener('click', fn); }
function bind() {
  click('settings', () => { settingsOpen = !settingsOpen; error = ''; render(); });
  click('onboard', () => {
    const learn = (document.querySelector('#learn-optin') as HTMLInputElement)?.checked ?? false;
    // Start the browser permission request synchronously in the user gesture.
    const permission = client.requestModels();
    void act(async () => {
      if (!await permission) throw new Error('Allow the model download hosts to use on-device AI. Firefox AI permission is not required.');
      nativeAccess = await client.nativeStatus();
      await client.send('settings', windowId, { learn, onboard: true });
      autoStarted = true;
      await client.send('organize', windowId);
    });
  });
  click('native-ai', () => {
    const permission = client.requestNative();
    void act(async () => {
      nativeAccess = await permission;
      nativeNote = nativeAccess === 'available' ? 'Firefox AI wasn’t enabled. You can continue using the bundled local AI.' : '';
    });
  });
  click('organize', () => { void act(() => client.send('organize', windowId, {
    retry: true, retryUndone: !!view?.retryCount, grouping: groupingChoice ?? view?.grouping,
  })); });
  click('undo', () => { void act(() => client.send('undo', windowId)); });
  click('finish-rejection', () => { void act(() => client.send('finish-rejection', windowId)); });
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-reject]')) button.addEventListener('click', () => {
    const threadId = button.dataset.reject;
    void act(() => client.send('reject', windowId, { threadId })).then(() => {
      if (!error) (document.getElementById('finish-rejection') ?? document.getElementById('organize'))?.focus();
    });
  });
  click('cancel', () => {
    // Organization has a pending response; cancellation must remain independent.
    void client.send('cancel', windowId).catch(e => { error = e.message; render(); });
  });
  click('clear', () => { void act(() => client.send('clear', windowId)); });
  click('reconsider', () => {
    void act(() => client.send('organize', windowId, { retry: true, includeExcluded: true, grouping: groupingChoice ?? view?.grouping }));
  });
  document.querySelector('#grouping')?.addEventListener('change', e => {
    const value = (e.target as HTMLSelectElement).value;
    if (value === 'balanced' || value === 'focused' || value === 'broad') groupingChoice = value;
  });
  document.querySelector('#learning')?.addEventListener('change', e => {
    const learn = (e.target as HTMLInputElement).checked;
    void act(() => client.send('settings', windowId, { learn }));
  });
  for (const row of root.querySelectorAll<HTMLButtonElement>('[data-thread]')) row.addEventListener('click', () => {
    void act(async () => { await client.send('resume', windowId, { threadId: row.dataset.thread }); window.close(); });
  });
}
client.onChange(() => { void refresh(); });
void (async () => {
  try {
    windowId = await client.windowId();
    nativeAccess = await client.nativeStatus();
    await refresh();
    if (view?.settings.onboarded && !autoStarted && !view.retryCount && !view.regroupCount && !view.canRecoverRejection && !view.progress && !view.otherWindowBusy && view.receipt?.kind !== 'error') {
      autoStarted = true;
      await client.send('organize', windowId);
      await refresh();
    }
  } catch (e) { error = e instanceof Error ? e.message : 'Thread could not start.'; render(); }
})();
