import { LocalIntelligence } from '../../ai/local';
import type { Progress } from '../../core/types';

const ai = new LocalIntelligence(chrome.runtime.getURL('ai/worker.js'));
let owner = '';
const leases = new Set<string>();
let active: { id: string; controller: AbortController } | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let idle: ReturnType<typeof setTimeout> | undefined;
const send = (message: Record<string, unknown>) => chrome.runtime.sendMessage(message).catch(() => undefined);
function timers() {
  clearInterval(heartbeat); clearTimeout(idle);
  // Only an explicitly running action keeps the service worker awake. No
  // permanent connection, idle heartbeat, or background tab organization.
  if (leases.size || active) heartbeat = setInterval(() => { void send({ target: 'thread:heartbeat', owner }); }, 20_000);
  else idle = setTimeout(() => { ai.release(); void send({ target: 'thread:idle', owner }); }, 90_000);
}
function reset(next: string) {
  active?.controller.abort(); active = undefined; ai.release();
  leases.clear(); owner = next; timers();
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!message || message.target !== 'thread:offscreen' || sender.id !== chrome.runtime.id ||
    !sender.url?.startsWith(chrome.runtime.getURL('')) || typeof message.owner !== 'string') return false;
  const respond = (ok: boolean) => { reply({ ok }); return false; };
  if (message.type === 'reset') { reset(message.owner); return respond(true); }
  if (message.owner !== owner) return respond(false);
  switch (message.type) {
    case 'begin':
      if (typeof message.id !== 'string') return respond(false);
      leases.add(message.id); timers(); return respond(true);
    case 'end': leases.delete(message.id); timers(); return respond(true);
    case 'cancel':
      leases.delete(message.id);
      if (active && active.id === message.id) { active.controller.abort(); active = undefined; }
      timers(); return respond(true);
    case 'release': ai.release(); return respond(true);
    case 'infer': {
      if (active || typeof message.id !== 'string' || !leases.has(message.id) || !Array.isArray(message.inputs) || !['embed', 'label'].includes(message.task)) return respond(false);
      const controller = new AbortController();
      const run = active = { id: message.id, controller };
      const generation = owner;
      const progress = (p: Progress) => { void send({ target: 'thread:progress', owner: generation, id: run.id, progress: p }); };
      timers();
      const work = message.task === 'embed' ? ai.embed(message.inputs, controller.signal, progress) : ai.label(message.inputs, controller.signal, progress);
      void work.then(result => {
        if (active === run && owner === generation) void send({ target: 'thread:result', owner: generation, id: run.id, result });
      }, () => {
        if (active === run && owner === generation) void send({ target: 'thread:result', owner: generation, id: run.id, error: true });
      }).finally(() => { if (active === run) { active = undefined; timers(); } });
      return respond(true);
    }
    default: return respond(false);
  }
});
