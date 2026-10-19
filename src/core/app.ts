import { colors, MAX_AGE, type AppState, type Intelligence, type OrganizeOptions, type Platform, type Progress, type RejectionRecord, type Repository, type Snapshot, type Tab, type Thread, type UndoRecord, type View } from './types';
import { cleanLabel, eligible, fingerprint, labelInput, reconcile, sharedTool } from './tabs';
import { plan } from './planner';
import { referenceThreads } from './preferences';
import { allowsGroup, rememberRejection } from './rejections';

export class ThreadApp {
  private busy = false;
  private applying = false;
  private currentWindow?: number;
  private progress?: Progress;
  private controller?: AbortController;
  private fatal?: string;
  private previous?: { tab: Tab; at: number };
  private ignoreActivityUntil = 0;
  readonly ready: Promise<void>;

  constructor(private platform: Platform, private repo: Repository, private ai: Intelligence, private notify: () => void) {
    this.ready = this.recover();
  }
  private async recover() {
    await this.repo.update(state => {
      if (state.job) {
        const memory = state.windows[state.job.windowKey] ??= { ignored: [] };
        memory.receipt = { kind: 'error', organized: 0, at: Date.now(), needsRecovery: state.job.phase !== 'analysis', message: state.job.phase === 'analysis'
          ? 'The last run was interrupted before any changes. Try again.'
          : state.job.phase === 'reject' ? 'Group rejection was interrupted. Use Finish rejection to safely complete it.'
          : 'The last operation was interrupted. Your tabs are still open. Use Undo to recover the recorded changes.' };
        delete memory.fingerprint;
        delete state.job;
      }
      state.links = state.links.filter(l => Date.now() - l.at < MAX_AGE);
    });
  }
  async settings(learn: boolean, onboard = false) {
    await this.ready;
    if (this.busy) throw new Error('Let the current operation finish first.');
    await this.repo.update(state => {
      state.settings.learn = learn;
      if (onboard) state.settings.onboarded = true;
      if (!learn) state.links = [];
      for (const memory of Object.values(state.windows)) delete memory.fingerprint;
    });
    this.previous = undefined;
    this.notify();
  }
  private setProgress = (progress: Progress) => { this.progress = progress; this.notify(); };

  async view(windowId: number): Promise<View> {
    await this.ready;
    let state = await this.repo.read();
    const base: View = { settings: state.settings, threads: [], total: 0, loose: 0, available: 0, excluded: 0, retryCount: 0, regroupCount: 0, canRecoverRejection: false, grouping: 'balanced', canUndo: false,
      otherWindowBusy: this.busy && this.currentWindow !== windowId,
      progress: this.currentWindow === windowId ? this.progress : undefined,
      canCancel: this.busy && !this.applying && this.currentWindow === windowId, error: this.fatal };
    if (!state.settings.onboarded) return base;
    const snapshot = await this.platform.snapshot(windowId);
    if (!this.busy) {
      await this.repo.update(s => { reconcile(s, snapshot); });
      state = await this.repo.read();
    }
    const memory = state.windows[snapshot.windowKey];
    base.threads = state.threads.filter(t => t.windowKey === snapshot.windowKey)
      .sort((a, b) => (snapshot.tabs.find(t => t.groupId === a.groupId)?.index ?? Infinity) - (snapshot.tabs.find(t => t.groupId === b.groupId)?.index ?? Infinity))
      .flatMap(thread => {
      const tabs = snapshot.tabs.filter(t => t.groupId === thread.groupId && thread.keys.includes(t.key));
      if (!tabs.length) return [];
      const last = [...tabs].sort((a, b) => Number(b.active) - Number(a.active) || b.lastAccessed - a.lastAccessed)[0];
      return [{ id: thread.id, title: snapshot.groups.find(g => g.id === thread.groupId)?.title || thread.title || 'Untitled group',
        color: thread.color, count: tabs.length, lastTitle: last.title || 'Untitled page', active: tabs.some(t => t.active),
        canReject: !this.busy && !memory?.pendingRejection && !memory?.receipt?.needsRecovery && thread.origin !== 'user' &&
          tabs.length === thread.keys.length && tabs.every(eligible) }];
    });
    base.total = snapshot.tabs.length;
    const loose = snapshot.tabs.filter(t => t.groupId === -1 && eligible(t));
    base.loose = loose.length;
    base.excluded = loose.filter(t => memory?.ignored.includes(t.key)).length;
    base.available = base.loose - base.excluded;
    base.retryCount = loose.filter(t => memory?.ignored.includes(t.key) && memory.retryKeys?.includes(t.key)).length;
    base.regroupCount = loose.filter(t => memory?.regroupKeys?.includes(t.key)).length;
    base.canRecoverRejection = !!memory?.pendingRejection;
    base.grouping = memory?.grouping ?? 'balanced';
    base.receipt = memory?.receipt;
    base.canUndo = !!memory?.undo?.steps.length && !memory.pendingRejection;
    return base;
  }

  async start(windowId: number, options: OrganizeOptions = {}): Promise<void> {
    await this.ready;
    if (this.busy) return;
    const state = await this.repo.read();
    if (!state.settings.onboarded) throw new Error('Complete the first-use setup first.');
    // Acquire before the first await in the operation; two popup requests cannot overlap.
    if (this.busy) return;
    this.busy = true; this.applying = false; this.currentWindow = windowId; this.fatal = undefined;
    this.controller = new AbortController();
    this.setProgress({ stage: 'Checking tabs', detail: 'Checking this window. No tabs will be closed.' });
    // Keep the initiating extension event pending for the duration of the work.
    // The persisted journal is still authoritative if Firefox stops this host.
    return this.organize(windowId, options, this.controller.signal).catch(() => {
      this.fatal = 'Thread could not save its state. Check available browser storage, then reopen the extension.';
    }).finally(() => {
      this.busy = false; this.applying = false; this.progress = undefined; this.controller = undefined;
      this.notify();
    });
  }
  cancel() { if (!this.applying) this.controller?.abort(); }

  private async organize(windowId: number, options: OrganizeOptions, signal: AbortSignal) {
    let snapshot: Snapshot | undefined;
    let applied = 0;
    let startedMutation = false;
    let changedDuringApply = false;
    try {
      snapshot = await this.platform.snapshot(windowId);
      await this.repo.update(state => { reconcile(state, snapshot!); });
      let state = await this.repo.read();
      const memory = state.windows[snapshot.windowKey];
      if (memory.pendingRejection) return;
      if (!options.retry && snapshot.tabs.some(t => t.groupId === -1 && eligible(t) && memory.regroupKeys?.includes(t.key))) return;
      const grouping = options.grouping ?? memory.grouping ?? 'balanced';
      const reconsider = new Set(snapshot.tabs.filter(t => t.groupId === -1 && eligible(t) && memory.ignored.includes(t.key) &&
        (options.includeExcluded || (options.retryUndone && memory.retryKeys?.includes(t.key)))).map(t => t.key));
      // Do not erase exclusions before analysis succeeds. Cancellation/download
      // failures leave the retry path and unrelated corrections intact.
      const ignored = memory.ignored.filter(k => !reconsider.has(k));
      const signature = await fingerprint(snapshot, ignored, state.settings.learn ? state.links : [], grouping, memory.rejectedGroups);
      if (!options.retry && !reconsider.size && memory.fingerprint === signature) return;
      // Do not overwrite a previous partial recovery journal with a new operation.
      if (memory.receipt?.needsRecovery && memory.undo?.steps.length) return;
      await this.repo.update(s => {
        s.windows[snapshot!.windowKey].grouping = grouping;
        s.job = { windowKey: snapshot!.windowKey, windowId, phase: 'analysis' };
      });
      const threads = referenceThreads(snapshot, state.threads);
      const groups = await plan(snapshot, threads, ignored, state.settings.learn ? state.links : [], this.ai, signal, this.setProgress, grouping, memory.rejectedGroups);
      const newGroups = groups.filter(g => !g.threadId);
      if (newGroups.length) {
        const inputs = newGroups.map(g => labelInput(snapshot!.tabs.filter(t => g.keys.includes(t.key)), snapshot!.tabs.filter(eligible)));
        const labels = await this.ai.label(inputs, signal, this.setProgress);
        const used = new Set(snapshot.groups.map(g => g.title.toLocaleLowerCase()));
        newGroups.forEach((group, i) => {
          let label = cleanLabel(labels[i] ?? '', inputs[i].keywords, inputs[i].titles);
          const base = label; let number = 2;
          while (used.has(label.toLocaleLowerCase())) label = base + ' ' + number++;
          used.add(label.toLocaleLowerCase()); group.title = label;
        });
      }
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      this.applying = true;
      this.setProgress({ stage: 'Organizing tabs', detail: 'Saving Undo before updating native tab groups.' });
      const undo: UndoRecord = { id: crypto.randomUUID(), epoch: snapshot.epoch, order: snapshot.tabs.map(t => t.key), steps: [], at: Date.now() };
      const alreadyApplied = new Set<string>();
      for (const group of groups) {
        const fresh = await this.platform.snapshot(windowId);
        const selected = group.keys.flatMap(key => {
          const before = snapshot!.tabs.find(t => t.key === key);
          const now = fresh.tabs.find(t => t.key === key);
          return before && now && before.url === now.url && before.title === now.title && now.groupId === -1 && eligible(now) &&
            before.container === now.container && !ignored.includes(key) && !alreadyApplied.has(key) ? [now] : [];
        });
        const existing = group.threadId ? threads.find(t => t.id === group.threadId) : undefined;
        if (selected.length !== group.keys.length) changedDuringApply = true;
        if (group.threadId && !existing) { changedDuringApply = true; continue; }
        if (selected.length < (existing ? 1 : 2) || new Set(selected.map(t => t.container)).size !== 1) { changedDuringApply = true; continue; }
        const target = existing ? fresh.groups.find(g => g.id === existing.groupId) : undefined;
        const beforeMembers = existing ? fresh.tabs.filter(t => t.groupId === existing.groupId) : [];
        if (existing && (!target || target.protected || target.title !== existing.title || beforeMembers.length !== existing.keys.length ||
          beforeMembers.some(t => !existing.keys.includes(t.key) || t.hidden || t.container !== selected[0].container ||
            snapshot!.tabs.find(before => before.key === t.key)?.url !== t.url ||
            snapshot!.tabs.find(before => before.key === t.key)?.title !== t.title))) { changedDuringApply = true; continue; }
        if (!allowsGroup([...beforeMembers, ...selected].map(t => t.key), memory.rejectedGroups)) { changedDuringApply = true; continue; }
        const threadId = existing?.id ?? crypto.randomUUID();
        const title = target ? target.title : group.title || 'Related pages';
        const color = target?.color ?? colors[(threads.length + undo.steps.length) % colors.length];
        const step = { threadId, created: !existing, stylePending: !existing, pendingColor: this.platform.defaultGroupColor, title, color, addedKeys: selected.map(t => t.key),
          beforeKeys: beforeMembers.map(t => t.key), collapsedBefore: target?.collapsed };
        undo.steps.push(step);
        await this.repo.update(s => {
          s.windows[snapshot!.windowKey].undo = structuredClone(undo);
          s.job = { windowKey: snapshot!.windowKey, windowId, phase: 'apply' };
        });
        startedMutation = true;
        const groupId = await this.platform.group(windowId, selected.map(t => t.id), existing?.groupId);
        undo.steps[undo.steps.length - 1].groupId = groupId;
        await this.repo.update(s => { s.windows[snapshot!.windowKey].undo = structuredClone(undo); });
        if (!existing) await this.platform.styleGroup(groupId, title, color, !selected.some(t => t.active));
        else if (target!.collapsed && selected.some(t => t.active)) {
          const live = await this.platform.snapshot(windowId);
          const group = live.groups.find(g => g.id === groupId);
          if (group && group.title === title && group.color === color) await this.platform.setCollapsed(false, {
            windowId, groupId, title, color, collapsed: group.collapsed,
            memberIds: live.tabs.filter(t => t.groupId === groupId).map(t => t.id),
          });
        }
        undo.steps[undo.steps.length - 1].stylePending = false;
        const after = await this.platform.snapshot(windowId);
        const keys = after.tabs.filter(t => t.groupId === groupId).map(t => t.key);
        undo.steps[undo.steps.length - 1].afterKeys = keys;
        undo.steps[undo.steps.length - 1].collapsedAfter = after.groups.find(g => g.id === groupId)?.collapsed;
        const thread: Thread = { id: threadId, origin: existing?.origin ?? 'thread', windowKey: snapshot.windowKey, groupId, epoch: snapshot.epoch,
          title, color, keys, updatedAt: Date.now() };
        await this.repo.update(s => {
          s.windows[snapshot!.windowKey].undo = structuredClone(undo);
          s.threads = [...s.threads.filter(t => t.id !== threadId), thread];
        });
        selected.forEach(t => alreadyApplied.add(t.key));
        applied += selected.length;
      }
      const final = await this.platform.snapshot(windowId);
      // Do not withdraw an exclusion from a tab changed or manually ungrouped
      // while this run was in flight, even if other candidates succeeded.
      const reconsidered = new Set(final.tabs.filter(now => {
        if (!reconsider.has(now.key)) return false;
        if (alreadyApplied.has(now.key)) return undo.steps.some(step => step.groupId === now.groupId && step.addedKeys.includes(now.key));
        const before = snapshot!.tabs.find(t => t.key === now.key);
        return now.groupId === -1 && eligible(now) && before?.url === now.url && before.title === now.title && before.container === now.container;
      }).map(t => t.key));
      if (reconsidered.size < reconsider.size) changedDuringApply = true;
      await this.repo.update(s => {
        reconcile(s, final);
        const m = s.windows[final.windowKey];
        m.ignored = m.ignored.filter(k => !reconsidered.has(k));
        m.retryKeys = m.retryKeys?.filter(k => m.ignored.includes(k));
        // Successful explicit organization consumes this pending choice. The
        // rejected-combination constraints themselves continue to apply.
        delete m.regroupKeys;
      });
      state = await this.repo.read();
      const finalMemory = state.windows[final.windowKey];
      const loose = final.tabs.filter(t => t.groupId === -1 && eligible(t));
      const excluded = loose.filter(t => finalMemory.ignored.includes(t.key)).length;
      const available = loose.length - excluded;
      const finalSignature = await fingerprint(final, finalMemory.ignored, state.settings.learn ? state.links : [], grouping, finalMemory.rejectedGroups);
      const noChange = changedDuringApply ? 'Tabs changed during analysis. They were left in place; you can try again.' :
        available && finalMemory.rejectedGroups?.length ? available + (available === 1 ? ' tab was' : ' tabs were') +
          ' left ungrouped. Earlier rejected combinations are kept apart. You can group these tabs manually in your browser.' :
        available === 1 ? 'No confident existing-group match for this tab. Leave it loose or add it to a group in your browser.' :
        available ? 'No confident matches for ' + available + ' ungrouped tabs. Try a different grouping style or group them in your browser.' :
        excluded ? excluded + (excluded === 1 ? ' tab is excluded.' : ' tabs are excluded.') + ' Include excluded tabs to reconsider them.' :
        final.groups.length ? 'No eligible ungrouped tabs. Existing groups are kept as they are.' :
        'No eligible tabs to organize. Open related web pages to get started.';
      await this.repo.update(s => {
        const m = s.windows[final.windowKey];
        if (changedDuringApply) delete m.fingerprint;
        else m.fingerprint = finalSignature;
        m.receipt = { kind: applied ? 'done' : 'empty', organized: applied, at: Date.now(),
          message: applied ? 'Organized ' + applied + (applied === 1 ? ' tab.' : ' tabs.') + ' No tabs were closed.' : noChange };
        delete s.job;
      });
    } catch (error) {
      const cancelled = error instanceof DOMException && error.name === 'AbortError';
      if (snapshot) await this.repo.update(s => {
        const m = s.windows[snapshot!.windowKey] ??= { ignored: [] };
        delete m.fingerprint;
        m.receipt = { kind: cancelled && !startedMutation ? 'empty' : 'error', organized: applied, at: Date.now(), needsRecovery: startedMutation,
          message: startedMutation ? 'Organization stopped partway through. Your tabs are still open. Use Undo before trying again.' :
            cancelled ? 'Stopped. Nothing changed.' : error instanceof Error ? error.message : 'The local AI could not finish. Nothing changed.' };
        delete s.job;
      });
      else this.fatal = error instanceof Error ? error.message : 'This window is not available.';
    }
  }

  async resume(windowId: number, threadId: string) {
    await this.ready;
    if (this.busy) return;
    const snapshot = await this.platform.snapshot(windowId);
    await this.repo.update(s => { reconcile(s, snapshot); });
    const state = await this.repo.read();
    const thread = state.threads.find(t => t.id === threadId && t.windowKey === snapshot.windowKey);
    if (!thread) throw new Error('This thread has changed. Reopen Thread to refresh it.');
    const last = snapshot.tabs.filter(t => t.groupId === thread.groupId && !t.hidden)
      .sort((a, b) => Number(b.active) - Number(a.active) || b.lastAccessed - a.lastAccessed)[0];
    if (last) {
      this.ignoreActivityUntil = Date.now() + 1500;
      await this.platform.activate(last.id, thread.groupId);
    }
  }

  async reject(windowId: number, threadId?: string) {
    await this.ready;
    if (this.busy) throw new Error('Let the current operation finish first.');
    this.busy = true; this.applying = true; this.currentWindow = windowId; this.fatal = undefined;
    this.setProgress({ stage: 'Rejecting group', detail: 'Keeping its tabs open and preserving your other groups.' });
    let snapshot: Snapshot | undefined;
    let journaled = false;
    try {
      snapshot = await this.platform.snapshot(windowId);
      let state = await this.repo.read();
      if (!state.settings.onboarded) throw new Error('Complete the first-use setup first.');
      let record = state.windows[snapshot.windowKey]?.pendingRejection;
      if (!record && !threadId) throw new Error('No interrupted group rejection remains. Reopen the panel.');
      if (record && threadId && record.threadId !== threadId) throw new Error('Finish the interrupted rejection first.');
      if (!record) {
        await this.repo.update(s => { reconcile(s, snapshot!); });
        state = await this.repo.read();
        if (state.windows[snapshot.windowKey].receipt?.needsRecovery) throw new Error('Use Undo to finish recovery first.');
        const thread = state.threads.find(t => t.id === threadId && t.windowKey === snapshot!.windowKey);
        const group = snapshot.groups.find(g => g.id === thread?.groupId);
        const members = snapshot.tabs.filter(t => t.groupId === group?.id);
        if (!thread || thread.origin === 'user' || !group || !members.length || members.some(t => !eligible(t))) {
          throw new Error('Only unchanged Thread-created groups without protected tabs can be rejected. Your tabs were left in place.');
        }
        record = { threadId: thread.id, groupId: group.id, epoch: snapshot.epoch, title: group.title, color: group.color, keys: members.map(t => t.key) };
      }
      const journal: RejectionRecord = record;
      // Separate journal: rejecting one group must not destroy Undo for the
      // other groups. A restart can finish an already-detached group safely.
      await this.repo.update(s => {
        s.windows[snapshot!.windowKey].pendingRejection = journal;
        s.job = { windowKey: snapshot!.windowKey, windowId, phase: 'reject' };
      });
      journaled = true;
      const current = await this.platform.snapshot(windowId);
      const remaining = current.tabs.filter(t => journal.keys.includes(t.key));
      const group = journal.epoch === current.epoch ? current.groups.find(g => g.id === journal.groupId) :
        current.groups.find(g => {
          const members = current.tabs.filter(t => t.groupId === g.id);
          return members.length > 0 && members.every(t => journal.keys.includes(t.key)) &&
            remaining.every(t => t.groupId === -1 || t.groupId === g.id) && g.title === journal.title && g.color === journal.color;
        });
      const members = current.tabs.filter(t => t.groupId === group?.id);
      if (group && members.length && group.title === journal.title && group.color === journal.color &&
        members.every(t => journal.keys.includes(t.key) && eligible(t)) && remaining.every(t => t.groupId === -1 || t.groupId === group.id)) {
        await this.platform.ungroup(members.map(t => t.id), { windowId, groupId: group.id, title: group.title, color: group.color,
          memberIds: members.map(t => t.id) });
      }
      const final = await this.platform.snapshot(windowId);
      const released = final.tabs.filter(t => journal.keys.includes(t.key) && t.groupId === -1 && eligible(t)).map(t => t.key);
      const kept = final.tabs.filter(t => journal.keys.includes(t.key) && !released.includes(t.key)).length;
      await this.repo.update(s => {
        const m = s.windows[final.windowKey];
        if (released.length) {
          rememberRejection(m, journal.keys);
          m.ignored = m.ignored.filter(k => !released.includes(k));
          m.retryKeys = m.retryKeys?.filter(k => !released.includes(k));
          m.regroupKeys = [...new Set([...(m.regroupKeys ?? []), ...released])];
          // Do not mistake our own detachment for the user manually ungrouping.
          for (const t of s.threads.filter(t => t.windowKey === final.windowKey)) t.keys = t.keys.filter(k => !released.includes(k));
          if (m.undo) {
            m.undo.steps = m.undo.steps.filter(step => step.threadId !== journal.threadId);
            if (!m.undo.steps.length) delete m.undo;
          }
        }
        reconcile(s, final);
        delete m.pendingRejection; delete m.fingerprint; delete s.job;
        m.receipt = { kind: released.length ? 'rejected' : 'empty', organized: 0, at: Date.now(),
          message: released.length && kept ? 'Released ' + released.length + ' tabs for the next run. Kept ' + kept + ' tabs where your later changes or protections require.' :
            released.length ? 'Group rejected. ' + released.length + (released.length === 1 ? ' tab stays' : ' tabs stay') +
            ' open for the next Organize ungrouped tabs run. Other groups stay in place.' :
            'The group changed or contains protected tabs. Nothing else was moved.' };
      });
    } catch (error) {
      if (!journaled || !snapshot) throw error;
      await this.repo.update(s => {
        s.windows[snapshot!.windowKey].receipt = { kind: 'error', organized: 0, at: Date.now(), needsRecovery: true,
          message: 'Group rejection was interrupted. Your tabs are still open. Use Finish rejection before organizing again.' };
        delete s.job;
      });
    } finally { this.busy = false; this.applying = false; this.progress = undefined; this.notify(); }
  }

  async undo(windowId: number) {
    await this.ready;
    if (this.busy) return;
    this.busy = true; this.applying = true; this.currentWindow = windowId;
    this.setProgress({ stage: 'Undoing organization', detail: 'Preserving new tabs and your later changes.' });
    let snapshot: Snapshot | undefined;
    try {
      snapshot = await this.platform.snapshot(windowId);
      const state = await this.repo.read();
      const record = state.windows[snapshot.windowKey]?.undo;
      if (!record || state.windows[snapshot.windowKey]?.pendingRejection) return;
      await this.repo.update(s => { s.job = { windowKey: snapshot!.windowKey, windowId, phase: 'undo' }; });
      const saveProgress = () => this.repo.update(s => { s.windows[snapshot!.windowKey].undo = structuredClone(record); });
      // Resume a detachment that completed before the worker could save its
      // result. Only surviving loose tabs qualify; newer manual groups win.
      const restored = [...new Set([...(record.detachedKeys ?? []), ...(record.detachingKeys ?? [])])].filter(key =>
        snapshot!.tabs.some(t => t.key === key && t.groupId === -1 && eligible(t)));
      record.detachedKeys = restored; delete record.detachingKeys;
      await saveProgress();
      const restoreCollapse = async (step: UndoRecord['steps'][number]) => {
        if (step.created || step.collapsedBefore === undefined || step.collapsedBefore === step.collapsedAfter) return;
        const current = await this.platform.snapshot(windowId);
        const before = step.beforeKeys.filter(key => current.tabs.some(t => t.key === key));
        const group = current.groups.find(g => (record.epoch !== current.epoch || step.groupId === undefined || g.id === step.groupId) &&
          g.title === step.title && g.color === step.color && g.collapsed === step.collapsedAfter && !g.protected &&
          current.tabs.filter(t => t.groupId === g.id).map(t => t.key).join('|') === before.join('|'));
        if (group) await this.platform.setCollapsed(step.collapsedBefore, { windowId, groupId: group.id, title: group.title,
          color: group.color, collapsed: step.collapsedAfter, memberIds: current.tabs.filter(t => t.groupId === group.id).map(t => t.id) });
      };
      let skipped = 0;
      for (const step of [...record.steps].reverse()) {
        let current = await this.platform.snapshot(windowId);
        const present = new Set(current.tabs.map(t => t.key));
        const expected = (step.afterKeys ?? [...step.beforeKeys, ...step.addedKeys]).filter(k => present.has(k) && !restored.includes(k));
        const added = step.addedKeys.filter(k => present.has(k) && !restored.includes(k));
        if (!added.length) { await restoreCollapse(step); continue; }
        let group = record.epoch === current.epoch ? current.groups.find(g => g.id === step.groupId) : undefined;
        if (!group && (record.epoch !== current.epoch || step.groupId === undefined)) {
          group = current.groups.find(g => {
            const members = current.tabs.filter(t => t.groupId === g.id);
            return members.length === expected.length && members.every(t => expected.includes(t.key));
          });
        }
        const members = current.tabs.filter(t => t.groupId === group?.id);
        const exact = step.afterKeys ? members.map(t => t.key).join('|') === expected.join('|') :
          members.length === expected.length && members.every(t => expected.includes(t.key));
        // A crash can land between native creation and applying our label.
        // Accept only the exact-membership, untouched default group (or the
        // intended style if that API already completed). Renames stay protected.
        const pendingDefault = step.stylePending && group?.title === '' && group.color === step.pendingColor;
        if (!group || !exact || group.protected || (step.created && !pendingDefault && (group.title !== step.title || group.color !== step.color)) || members.some(t => added.includes(t.key) && !eligible(t))) {
          skipped += added.length; continue;
        }
        record.detachingKeys = added;
        await saveProgress();
        const detached = await this.platform.ungroup(members.filter(t => added.includes(t.key)).map(t => t.id), {
          windowId, groupId: group.id, title: group.title, color: group.color, memberIds: members.map(t => t.id),
        });
        if (detached) restored.push(...added);
        else skipped += added.length;
        record.detachedKeys = [...restored]; delete record.detachingKeys;
        await saveProgress();
        if (!detached) continue;
        await restoreCollapse(step);
      }
      // Detach all safe additions before restoring order. A tab in a different
      // undo step is not a stable position anchor until that step is detached.
      // Move only affected tabs, backwards through the original global order.
      for (const key of [...restored].sort((a, b) => record.order.indexOf(b) - record.order.indexOf(a))) {
        const current = await this.platform.snapshot(windowId);
        const tab = current.tabs.find(t => t.key === key);
        if (!tab || !eligible(tab) || tab.groupId !== -1) continue;
        const later = record.order.slice(record.order.indexOf(key) + 1);
        const nextKey = later.find(k => current.tabs.some(t => t.key === k && !t.pinned));
        const next = current.tabs.find(t => t.key === nextKey);
        let target = next?.index ?? -1;
        // Never insert in the middle of someone else's native group.
        if (next && next.groupId !== -1) target = Math.min(...current.tabs.filter(t => t.groupId === next.groupId).map(t => t.index));
        if (target > tab.index) target--;
        await this.platform.move(tab.id, target, windowId);
        await this.platform.ungroup([tab.id], { windowId, groupId: -1 });
      }
      const final = await this.platform.snapshot(windowId);
      await this.repo.update(s => {
        // Undoing our own additions must not turn an AI-created group into an
        // inferred user preference. Later manual changes are still reconciled.
        for (const thread of s.threads.filter(t => t.windowKey === final.windowKey)) {
          thread.keys = thread.keys.filter(k => !restored.includes(k));
        }
        reconcile(s, final);
        const m = s.windows[final.windowKey];
        m.ignored = [...new Set([...m.ignored, ...restored])];
        m.retryKeys = restored;
        delete m.undo;
        m.receipt = { kind: 'undone', organized: 0, at: Date.now(), message: !restored.length
          ? 'Nothing could be undone safely. Closed tabs and your later changes were left alone.' : skipped
          ? 'Restored ' + restored.length + ' tabs. Kept ' + skipped + ' tabs where your later changes put them.'
          : 'Organization undone. Choose a grouping style and organize again when you’re ready.' };
        delete s.job;
      });
      const updated = await this.repo.read();
      const signature = await fingerprint(final, updated.windows[final.windowKey].ignored, updated.settings.learn ? updated.links : [], updated.windows[final.windowKey].grouping, updated.windows[final.windowKey].rejectedGroups);
      await this.repo.update(s => { s.windows[final.windowKey].fingerprint = signature; });
    } catch {
      if (snapshot) await this.repo.update(s => {
        s.windows[snapshot!.windowKey].receipt = { kind: 'error', organized: 0, at: Date.now(), needsRecovery: true,
          message: 'Undo was interrupted. Your tabs are still open. Reopen Thread to try the remaining recovery.' };
        delete s.job;
      });
    } finally { this.busy = false; this.applying = false; this.progress = undefined; this.notify(); }
  }

  async clearLearning(windowId: number, retryLoose = false) {
    await this.ready;
    if (this.busy) throw new Error('Let the current operation finish first.');
    const snapshot = await this.platform.snapshot(windowId);
    await this.repo.update(state => {
      const memory = state.windows[snapshot.windowKey] ??= { ignored: [] };
      if (retryLoose) {
        // Compatibility with an already-open older popup. Reconsidering tabs
        // must not erase activity connections, especially in other windows.
        memory.ignored = []; delete memory.retryKeys; delete memory.fingerprint;
      } else {
        state.links = [];
        for (const m of Object.values(state.windows)) delete m.fingerprint;
      }
    });
    if (!retryLoose) { this.previous = undefined; this.ai.release(); }
    this.notify();
  }
  resetActivity() { this.previous = undefined; }
  async activity(tab: Tab, windowKey: string, focused: boolean) {
    await this.ready;
    const state = await this.repo.read();
    const previous = this.previous;
    this.previous = undefined;
    if (!state.settings.learn || !state.windows[windowKey] || !focused || !eligible(tab) || sharedTool(tab) ||
      this.busy || Date.now() < this.ignoreActivityUntil) return;
    const now = Date.now();
    this.previous = { tab, at: now };
    if (!previous || previous.tab.windowId !== tab.windowId || previous.tab.container !== tab.container || previous.tab.key === tab.key ||
      now - previous.at < 1000 || now - previous.at > 10 * 60000) return;
    const [a, b] = [previous.tab.key, tab.key].sort();
    await this.repo.update(s => {
      if (!s.settings.learn) return;
      s.links = s.links.filter(l => now - l.at < MAX_AGE);
      const link = s.links.find(l => l.a === a && l.b === b);
      if (link) { link.weight = Math.min(link.weight + 1, 12); link.at = now; }
      else s.links.push({ a, b, weight: 1, at: now });
      s.links.sort((x, y) => y.at - x.at);
      s.links = s.links.slice(0, 500);
    });
  }
  async forgetKey(key: string) {
    await this.repo.update(s => {
      s.links = s.links.filter(l => l.a !== key && l.b !== key);
      for (const m of Object.values(s.windows)) {
        m.rejectedGroups = m.rejectedGroups?.filter(keys => !keys.includes(key));
        m.regroupKeys = m.regroupKeys?.filter(k => k !== key);
      }
    });
  }
}
