import type { NativeAccess, Presentation } from '../presentation';
export type { NativeAccess } from '../presentation';

export const presentation: Presentation = {
  nativeButton: '', nativeAllowed: '', nativeUnavailable: '', nativeDeclined: '',
  onboardingAI: 'Both AI models run locally inside the extension. No account, API key, experimental browser feature, or cloud AI is needed.',
  download: 'The first run downloads about 85 MB of models from Hugging Face. It receives model-file requests, not your tabs. Models are saved locally for later use.',
  settingsAI: 'The same compact models used by Thread for Firefox run locally in Chrome. Chrome’s built-in generative AI is not required and is not used for grouping.',
  runtimePrivacy: 'Chrome may independently synchronize native groups according to your browser settings. Thread never synchronizes its extension data or adds tabs to collaborative shared groups.',
  identityPrivacy: 'Chrome keeps opaque tab identities for this browser session. Undo, tab-specific corrections, and learned connections reset when Chrome restarts or the extension is reloaded/updated. Native groups, model downloads, and your settings remain. Existing groups continue to guide new matches.',
  protections: 'Pinned, playing, frozen, split-view tabs and shared groups are protected. Chrome does not expose a reliable camera/microphone/screen-sharing indicator to Thread.',
  permissionError: 'Allow access to the model download hosts to use on-device AI. No Chrome AI permission is required.',
};
const MODEL_ORIGINS = ['https://huggingface.co/*', 'https://*.huggingface.co/*', 'https://*.hf.co/*'];
export const client = {
  async windowId(): Promise<number> {
    if (!chrome.tabs.group || !chrome.tabs.ungroup || !chrome.tabGroups?.query || !chrome.offscreen?.createDocument) {
      throw new Error('Desktop Chrome 121 or newer with native tab groups and offscreen documents is required.');
    }
    const win = await chrome.windows.getCurrent();
    if (win.incognito || win.type !== 'normal' || win.id === undefined) throw new Error('Thread only works in a normal, non-Incognito Chrome window.');
    return win.id;
  },
  async send<T = void>(type: string, windowId: number, args: Record<string, unknown> = {}): Promise<T> {
    const result = await chrome.runtime.sendMessage({ type, windowId, ...args });
    if (!result?.ok) throw new Error(result?.error ?? 'Thread could not connect. Reload the extension and try again.');
    return result.value as T;
  },
  modelsAllowed(): Promise<boolean> {
    return chrome.permissions.contains({ origins: MODEL_ORIGINS }).catch(() => false);
  },
  requestModels(): Promise<boolean> {
    try { return chrome.permissions.request({ origins: MODEL_ORIGINS }).catch(() => false); }
    catch { return Promise.resolve(false); }
  },
  async nativeStatus(): Promise<NativeAccess> { return 'unavailable'; },
  async requestNative(): Promise<NativeAccess> { return 'unavailable'; },
  onChange(fn: () => void) {
    chrome.runtime.onMessage.addListener(message => { if (message?.type === 'thread:changed') fn(); return false; });
  },
};
