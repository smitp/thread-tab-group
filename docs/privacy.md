# Thread privacy disclosure

Applies to Thread for Firefox 0.2.1 and to the Firefox and Chrome 0.3.0 builds.

## What Thread processes

Thread uses open tab titles, group names, and minimized address information to organize the current window on your device. It checks tab/group state to protect pinned tabs and respect existing organization. Firefox containers stay separate. Firefox also reports hidden and media-sharing tabs; Chrome reports audible, frozen and split-view tabs, but does not expose a reliable camera/microphone/screen-sharing indicator to Thread. Chrome collaborative shared groups are protected.

Thread does not read page contents, cookies, keystrokes, screenshots, or closed browsing history. It does not operate in private or Incognito windows. Chrome describes the `tabs` permission as access to browsing history; Thread uses it for open tab metadata, does not request the `history` permission, and does not call the history API.

There is no Thread account system, cloud inference service, advertising, or analytics endpoint. Thread does not send tab titles, page addresses, generated labels, or activity connections to an AI service, model host, or the publisher. No user data is sold, used for advertising, used to train a remote model, or made available for human review. Data is used only for the tab-grouping and correction features described here. Thread's use of data complies with the Chrome Web Store User Data Policy, including its Limited Use requirements.

Your browser may independently synchronize native tabs/groups or collect diagnostics according to its own settings. Thread does not change those settings or claim to disable browser diagnostics. Thread does not synchronize its extension storage or automatically add tabs to collaborative shared groups.

## Model downloads

With your permission, Thread downloads model files from Hugging Face and its download/CDN subdomains. Optional Firefox AI also uses Mozilla's model infrastructure. These hosts receive file requests and ordinary network information such as your IP address. Their handling of those requests is governed by their own policies. Tab inputs are not included in the downloads. Thread's bundled downloader omits credentials and referrers.

The two models total approximately 85 MB. Firefox's optional native runtime may require an additional download. Native and bundled model caches are separate; the first use of either path needs network access. Cached bundled models can run offline. All executable JavaScript, workers, ONNX runtime modules, and WebAssembly are packaged with the extension. Only pinned model/data files are downloaded.

Firefox AI is optional and requested separately from model-host access. Declining it, an unavailable API, or a native failure does not disable bundled local inference. Firefox manages its native runtime and model cache. Cancellation stops use of native results, but an already-started native download/computation can continue.

Chrome runs both models in a packaged worker hosted by an offscreen document. It does not use Gemini Nano, Chrome's Prompt API, a remote model, or an experimental AI permission. Closing the popup does not cancel an accepted organization; the Cancel action does. The inference worker and its text caches are released after inactivity. An idle offscreen document is then closed when Chrome permits.

## Local storage and retention

Thread stores settings, group identities/names/membership, manual exclusions, the latest organization Undo record, and pending recovery journals in local extension storage. This storage is not a separately encrypted vault; normal operating-system and browser-profile protections apply. It does not back up page contents or unsaved forms.

In Firefox, opaque tab/window identities attached through the sessions API support continuity across session restoration. Thread does not look up closed history or restore sessions. Records are reconciled when their window is used; unrelated closed-window organization records can remain in Firefox's local extension storage until uninstall.

In Chrome, opaque identities are kept in session-only extension storage. They survive service-worker suspension. On a full browser restart or extension reload/update, Thread discards old tab-specific organization records, Undo, exclusions, rejected combinations, and learned connections before accepting work in the new session. Native groups, model files, and settings remain. Thread treats restored groups as user-owned references and never guesses tab identity from a URL/title. Observed closed windows are removed from Chrome's organization records.

An explicit **Reject** records a combination's opaque tab identities, not copies of page text, URLs, or model inputs. Up to 50 combinations are remembered per window, separately from passive activity learning. A combination is discarded when a member is observed closed/absent from that window or when you manually regroup all its members. Entries beyond the limit are discarded. Complete combinations and their supersets are blocked; smaller subsets can form new groups.

Released tabs remain open and wait for an explicit organizing action. Manually created or corrected groups and unrelated exclusions are not silently reset. Normal organization never closes tabs or merges existing groups. There is no cloud profile of corrections.

## Optional activity learning

Activity learning is off by default. If enabled, Thread remembers up to 500 tab-to-tab connections locally, only in windows where Thread has been used. Connections expire after seven days and are pruned when the extension runs. Closed-tab connections are removed when observed; Chrome also clears them on a new browser session or extension reload/update.

Disabling learning or selecting **Clear learned connections** removes these activity records. It does not erase native groups, manual exclusions, rejection feedback, or Undo within the current session. Group preferences are inferred from current open groups even with activity learning off. No separate site-preference profile is stored.

Inference-text caches are memory-only and released after inactivity. Model files can remain in browser-managed caches. Firefox controls its native engine's lifetime and shared model cache.

## Your controls

- Reject eligible Thread-created groups, or use Undo for the latest organization where safe.
- Group tabs manually to override earlier rejected-combination feedback.
- Include excluded tabs explicitly from the main panel without clearing activity connections.
- Disable activity learning or clear it in Settings.
- Revoke optional model-host access in your browser's extension settings. Firefox's native AI permission can be revoked separately.
- Uninstall Thread to remove its extension storage. Browser-managed shared model caches may remain; Thread does not delete shared caches silently.

Revoking download access can prevent an uncached model from loading. It does not transmit tab data elsewhere or enable a cloud fallback.

## Contact

Use [GitHub Issues](https://github.com/smitp/thread-tab-group/issues) for support.

Issues are public. Do not post private tab titles or addresses, personal information, credentials, or confidential security details. GitHub is a separate service governed by its own policies. Thread never automatically sends data to the issue tracker. The Chrome Web Store also displays the publisher's verified contact email; this is separate from Thread's processing of tab data.
