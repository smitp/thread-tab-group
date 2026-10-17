export type GroupColor = 'blue' | 'purple' | 'cyan' | 'orange' | 'green' | 'pink' | 'red' | 'yellow' | 'grey';

export interface Tab {
  id: number;
  key: string;
  windowId: number;
  index: number;
  groupId: number;
  container: string;
  title: string;
  url: string;
  active: boolean;
  pinned: boolean;
  hidden: boolean;
  busy: boolean;
  lastAccessed: number;
  openerId?: number;
}
export interface Group {
  id: number;
  title: string;
  color: GroupColor;
  collapsed: boolean;
}
export interface Snapshot {
  windowId: number;
  windowKey: string;
  epoch: string;
  tabs: Tab[];
  groups: Group[];
}
export interface Thread {
  id: string;
  /** Missing in older state means Thread-created, not a user preference. */
  origin?: 'thread' | 'user';
  windowKey: string;
  groupId: number;
  epoch: string;
  title: string;
  color: GroupColor;
  keys: string[];
  updatedAt: number;
}
export interface Link { a: string; b: string; weight: number; at: number }
export type GroupingStyle = 'balanced' | 'focused' | 'broad';
export interface OrganizeOptions { retry?: boolean; grouping?: GroupingStyle; retryUndone?: boolean; includeExcluded?: boolean }
export interface PlanGroup { threadId?: string; title?: string; keys: string[] }
export interface Progress { stage: string; detail: string; percent?: number }
export interface UndoStep {
  threadId: string;
  groupId?: number;
  created: boolean;
  title: string;
  color: GroupColor;
  addedKeys: string[];
  beforeKeys: string[];
  afterKeys?: string[];
  collapsedBefore?: boolean;
  collapsedAfter?: boolean;
}
export interface UndoRecord {
  id: string;
  epoch: string;
  order: string[];
  steps: UndoStep[];
  at: number;
}
export interface RejectionRecord {
  threadId: string;
  groupId: number;
  epoch: string;
  title: string;
  color: GroupColor;
  keys: string[];
}
export interface Receipt {
  kind: 'done' | 'empty' | 'error' | 'undone' | 'rejected';
  message: string;
  organized: number;
  at: number;
  needsRecovery?: boolean;
}
export interface WindowMemory {
  ignored: string[];
  /** Only tabs restored by the latest Undo; other manual exclusions stay separate. */
  retryKeys?: string[];
  /** Released by explicit rejection; wait for the next deliberate organize. */
  regroupKeys?: string[];
  rejectedGroups?: string[][];
  pendingRejection?: RejectionRecord;
  grouping?: GroupingStyle;
  fingerprint?: string;
  receipt?: Receipt;
  undo?: UndoRecord;
}
export interface AppState {
  version: 1;
  settings: { onboarded: boolean; learn: boolean };
  threads: Thread[];
  windows: Record<string, WindowMemory>;
  links: Link[];
  job?: { windowKey: string; windowId: number; phase: 'analysis' | 'apply' | 'undo' | 'reject' };
}
export interface ThreadView {
  id: string;
  title: string;
  color: GroupColor;
  count: number;
  lastTitle: string;
  active: boolean;
  canReject: boolean;
}
export interface View {
  settings: AppState['settings'];
  threads: ThreadView[];
  total: number;
  loose: number;
  available: number;
  excluded: number;
  retryCount: number;
  regroupCount: number;
  canRecoverRejection: boolean;
  grouping: GroupingStyle;
  receipt?: Receipt;
  canUndo: boolean;
  progress?: Progress;
  otherWindowBusy: boolean;
  canCancel?: boolean;
  error?: string;
}
export interface Platform {
  snapshot(windowId: number): Promise<Snapshot>;
  group(windowId: number, tabIds: number[], existingGroup?: number): Promise<number>;
  styleGroup(id: number, title: string, color: GroupColor, collapsed: boolean): Promise<void>;
  ungroup(ids: number[]): Promise<void>;
  move(id: number, index: number): Promise<void>;
  activate(tabId: number, groupId: number): Promise<void>;
}
export interface Repository {
  read(): Promise<AppState>;
  update(fn: (state: AppState) => void): Promise<void>;
}
export interface Intelligence {
  embed(texts: string[], signal: AbortSignal, progress: (p: Progress) => void): Promise<number[][]>;
  label(inputs: { keywords: string[]; titles: string[] }[], signal: AbortSignal, progress: (p: Progress) => void): Promise<string[]>;
  release(): void;
}
export const initialState = (): AppState => ({
  version: 1, settings: { onboarded: false, learn: false }, threads: [], windows: {}, links: [],
});
export const colors: GroupColor[] = ['green', 'blue', 'orange', 'purple', 'pink', 'cyan', 'yellow'];
export const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
