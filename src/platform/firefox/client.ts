export const MODEL_ORIGINS = ['https://huggingface.co/*', 'https://*.huggingface.co/*', 'https://*.hf.co/*'];
// Firefox's trial_ml.json declares this optional permission. The external
// WebExtension typings omit experimental permissions and the trial namespace.
const NATIVE_PERMISSION = 'trialML' as browser._manifest.OptionalPermission;
export type NativeAccess = 'available' | 'allowed' | 'unavailable';
function declaresNative(): boolean {
  // Inspect the loaded manifest, not the file on disk: a temporary add-on can
  // still have an older manifest, or Firefox can omit an unsupported permission.
  return browser.runtime.getManifest().optional_permissions?.some(p => p === 'trialML') ?? false;
}

export const client = {
  async windowId(): Promise<number> {
    if (!browser.tabs.group || !browser.tabs.ungroup || !browser.tabGroups?.query || !browser.tabGroups?.update) {
      throw new Error('Desktop Firefox 140 or newer with native tab groups is required. Firefox AI is optional.');
    }
    const win = await browser.windows.getCurrent();
    if (win.incognito || win.type !== 'normal' || win.id === undefined) throw new Error('Thread only works in a normal, non-private Firefox window.');
    return win.id;
  },
  async send<T = void>(type: string, windowId: number, args: Record<string, unknown> = {}): Promise<T> {
    const message = { type, windowId, ...args };
    let result;
    try { result = await browser.runtime.sendMessage(message); }
    catch (error) {
      // A dormant event page can race message delivery. Retry only Firefox's
      // explicit no-receiver failure, never a lost response to an accepted
      // mutation. Wake the Firefox background page and resend once.
      if (!(error instanceof Error) || error.message !== 'Could not establish connection. Receiving end does not exist.') throw error;
      await browser.runtime.getBackgroundPage();
      result = await browser.runtime.sendMessage(message);
    }
    if (!result?.ok) throw new Error(result?.error ?? 'Thread could not connect. Reload the extension and try again.');
    return result.value as T;
  },
  requestModels(): Promise<boolean> {
    // trialML is OptionalOnlyPermission: Firefox rejects combining it with
    // origins or another permission. Essential setup requests download access
    // only; native inference has its own optional, trusted-click request.
    try { return browser.permissions.request({ origins: MODEL_ORIGINS }).catch(() => false); }
    catch { return Promise.resolve(false); }
  },
  async nativeStatus(): Promise<NativeAccess> {
    try {
      if (!declaresNative()) return 'unavailable';
      return await browser.permissions.contains({ permissions: ['trialML'] }) ? 'allowed' : 'available';
    } catch { return 'unavailable'; }
  },
  requestNative(): Promise<NativeAccess> {
    // Call request synchronously in the click handler; awaiting a capability
    // query first would lose Firefox's user-input permission context.
    try {
      if (!declaresNative()) return Promise.resolve('unavailable');
      return browser.permissions.request({ permissions: [NATIVE_PERMISSION] })
        .then(allowed => allowed ? 'allowed' as const : 'available' as const, () => 'unavailable' as const);
    } catch { return Promise.resolve('unavailable'); }
  },
  onChange(fn: () => void) {
    browser.runtime.onMessage.addListener(message => { if (message?.type === 'thread:changed') fn(); });
  },
};
