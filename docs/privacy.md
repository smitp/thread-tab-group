# Thread privacy disclosure

Applies to Thread 0.2.1. Prepared for owner review before publication.

## What Thread processes

Thread uses open tab titles, group names, and minimized address information to organize the current window on your device. It also checks tab/group state to protect pinned, hidden, playing/sharing tabs and keep Firefox containers separate. It does not read page contents, cookies, keystrokes, screenshots, or closed browsing history. It does not operate in private windows.

Thread has no account system, cloud inference service, advertising, or analytics endpoint. Thread does not send browsing inputs to model-download hosts.

## Downloads and Firefox AI

With your permission, the extension downloads model files from Hugging Face (including its download/CDN subdomains) and, when optional Firefox AI is used, Mozilla’s model infrastructure. These services receive the file requests and ordinary network information such as your IP address. Their handling of download requests is governed by their own policies.

Models total approximately 85 MB; Firefox may additionally download its own runtime components. Native and bundled caches are separate. A first download needs network access. Thread’s bundled executable JavaScript and WebAssembly are packaged with the extension, not fetched from a model host.

Firefox AI permission is optional and requested separately from model-host permission. The bundled local implementation remains available when Firefox AI is declined, unavailable, or fails. Firefox’s native runtime follows Firefox’s own diagnostic/download settings. Thread neither changes those settings nor claims to disable Firefox diagnostics. Cancelling stops use of native results, but an already-started native download or computation may continue.

## Local storage and corrections

Thread stores settings, group identities/names/membership, manual exclusions, the latest organization Undo record, and any pending recovery journal in Firefox’s local extension storage. Opaque identities attached to tabs/windows through Firefox’s sessions API support continuity. No closed-history lookup or session-restore operation is performed.

An explicit **Reject** records the combination’s opaque tab identities, not a copy of page text, URLs, or model inputs. Up to 50 combinations are remembered per window, separately from optional activity learning. A combination is discarded when a member is observed closed/absent from that window or when you manually regroup all its members. Older entries beyond the bound are discarded. Only the complete combination and supersets are blocked; its smaller subsets can still form useful groups. Your manual grouping takes priority.

Released tabs remain open and wait for the next explicit organizing action. Pinned/hidden/playing/sharing tabs, manually created or corrected groups, and unrelated exclusions are not silently reset. There is no cloud profile or synchronization of corrections.

## Optional activity learning

Activity learning is off by default. If you enable it, Thread remembers up to 500 tab-to-tab connections locally, only in windows where Thread has been used. Connections expire after seven days and are pruned when the extension runs; closed-tab connections are removed when observed. Disabling learning or selecting **Clear learned connections** removes these activity records. This does not erase groups, manual exclusions, rejection feedback, or Undo.

Inference-text caches are memory-only and released after inactivity. Model files can remain in browser-managed caches. Firefox manages the lifetime and cache of its native engine.

## Your controls

- Reject individual eligible Thread-created groups, or use Undo for the latest organization where safe.
- Manually group tabs in Firefox to override earlier rejected-combination feedback.
- Explicitly include excluded tabs from the main panel without clearing learned connections.
- Disable activity learning or clear its records in Settings.
- Revoke optional permissions in Firefox’s extension settings.
- Uninstall Thread to remove its extension storage. Firefox-managed native model caches may remain; Thread does not silently delete shared browser caches.

## Publisher contact

For support, use [GitHub Issues](https://github.com/smitp/thread-tab-group/issues).

Issues are public. Do not post private tab titles or addresses, personal information, credentials, or confidential security details. Using GitHub is separate from the extension and subject to GitHub’s policies; Thread does not automatically send data to the issue tracker. No personal support email address is published.
