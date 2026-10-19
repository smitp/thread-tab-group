import type { ThreadApp } from '../core/app';
import type { GroupingStyle } from '../core/types';

export type Request = { type: string; windowId?: number; [key: string]: unknown };

/** The same validated command contract is used by both browser hosts. */
export async function dispatch(app: ThreadApp, message: Request, validateWindow: (id: number) => Promise<void>,
  launch: (run: () => Promise<void>) => Promise<void> = run => run()): Promise<unknown> {
  const id = message.windowId;
  if (message.type !== 'settings' && (!Number.isInteger(id) || id! < 0)) throw new Error('No browser window selected.');
  if (Number.isInteger(id)) await validateWindow(id!);
  switch (message.type) {
    case 'view': return app.view(id!);
    case 'organize': {
      if (message.grouping !== undefined && !['balanced', 'focused', 'broad'].includes(message.grouping as string)) throw new Error('Unknown grouping style.');
      return launch(() => app.start(id!, { retry: message.retry === true, grouping: message.grouping as GroupingStyle | undefined,
        retryUndone: message.retryUndone === true, includeExcluded: message.includeExcluded === true }));
    }
    case 'cancel': app.cancel(); return;
    case 'undo': return app.undo(id!);
    case 'reject':
      if (typeof message.threadId !== 'string') throw new Error('No group selected.');
      return app.reject(id!, message.threadId);
    case 'finish-rejection': return app.reject(id!);
    case 'resume':
      if (typeof message.threadId !== 'string') throw new Error('No group selected.');
      return app.resume(id!, message.threadId);
    case 'settings':
      if (typeof message.learn !== 'boolean') throw new Error('Invalid preference.');
      return app.settings(message.learn, message.onboard === true);
    case 'clear': return app.clearLearning(id!, message.retryLoose === true);
    default: throw new Error('Unknown action.');
  }
}
