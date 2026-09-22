export const NOTEBOOK_AUTO_RUN_DELAY_MS = 600;

export interface NotebookAutoRunState {
  enabled: boolean;
  pendingCount: number;
  paused: boolean;
}
export const INITIAL_NOTEBOOK_AUTO_RUN_STATE: NotebookAutoRunState = { enabled: false, pendingCount: 0, paused: false };

interface Environment {
  documentKey: string;
  contextKey: string;
  editing: boolean;
  busy: boolean;
  hidden: boolean;
  canEdit: boolean;
  externalBusy: boolean;
}
interface Handlers { run: (cellIds: string[]) => void; cancelAutomatic: () => void }
interface ApprovedSave { previousKey: string; expectedKey: string; accepted: boolean; roots: Set<string> }

/** Only explicit, validated save events can enqueue work. Document observation
 * acknowledges that save; it never infers permission to run an external edit. */
export class NotebookAutoRunScheduler {
  private enabled = false;
  private environment: Environment | null = null;
  private handlers: Handlers | null = null;
  private queue: ApprovedSave | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private state = INITIAL_NOTEBOOK_AUTO_RUN_STATE;

  constructor(private readonly changed: (state: NotebookAutoRunState) => void) {}

  update(environment: Environment, handlers: Handlers) {
    const contextChanged = this.environment !== null && this.environment.contextKey !== environment.contextKey;
    this.environment = environment;
    this.handlers = handlers;
    if (contextChanged) { this.clearTimer(); this.queue = null; handlers.cancelAutomatic(); }
    if (environment.hidden || !environment.canEdit) this.enabled = false;
    if (!this.enabled || environment.hidden || !environment.canEdit || environment.externalBusy) {
      this.clearTimer(); this.queue = null; handlers.cancelAutomatic();
    } else if (this.queue) {
      if (this.queue.expectedKey === environment.documentKey) this.queue.accepted = true;
      else if (this.queue.accepted || this.queue.previousKey !== environment.documentKey) {
        this.clearTimer(); this.queue = null;
      }
    }
    this.reconcile();
  }

  setEnabled(enabled: boolean) {
    const env = this.environment;
    this.enabled = enabled && Boolean(env && !env.hidden && env.canEdit && !env.externalBusy);
    if (!this.enabled) { this.clearTimer(); this.queue = null; this.handlers?.cancelAutomatic(); }
    this.reconcile();
  }

  approve(previousKey: string, expectedKey: string, roots: readonly string[]) {
    if (!this.enabled || !roots.length) return;
    const env = this.environment;
    if (!env || env.hidden || !env.canEdit || env.externalBusy || env.busy) return;
    const merged = this.queue?.expectedKey === previousKey ? this.queue.roots : new Set<string>();
    this.queue = { previousKey, expectedKey, accepted: expectedKey === env.documentKey, roots: new Set([...merged, ...roots]) };
    this.clearTimer(); this.reconcile();
  }

  clearPending() { this.clearTimer(); this.queue = null; this.publish(); }

  dispose() {
    this.clearTimer(); this.queue = null; this.enabled = false;
    this.handlers?.cancelAutomatic();
  }

  private clearTimer() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private reconcile() {
    const env = this.environment;
    const ready = this.enabled && this.queue?.accepted && env && !env.editing && !env.busy
      && !env.hidden && env.canEdit && !env.externalBusy && this.queue.expectedKey === env.documentKey;
    if (!ready) this.clearTimer();
    else if (this.timer === null) this.timer = setTimeout(() => {
      this.timer = null;
      const roots = this.queue ? [...this.queue.roots] : [];
      this.queue = null; this.publish();
      if (roots.length) this.handlers?.run(roots);
    }, NOTEBOOK_AUTO_RUN_DELAY_MS);
    this.publish();
  }

  private publish() {
    const state = { enabled: this.enabled, pendingCount: this.queue?.roots.size ?? 0,
      paused: Boolean(this.queue && (this.environment?.editing || this.environment?.busy || !this.queue.accepted)) };
    if (state.enabled === this.state.enabled && state.pendingCount === this.state.pendingCount && state.paused === this.state.paused) return;
    this.state = state; this.changed(state);
  }
}
