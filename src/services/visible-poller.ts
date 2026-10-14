export type PollDelay = number | null;

type VisibilityDocument = Pick<Document, "hidden" | "addEventListener" | "removeEventListener">;
type TimerHandle = ReturnType<typeof setTimeout>;
type TimerHost = {
  setTimeout(callback: () => void, delay: number): TimerHandle;
  clearTimeout(handle: TimerHandle | undefined): void;
};

export type VisiblePollOptions = {
  document?: VisibilityDocument | null;
  timers?: TimerHost;
  errorDelayMs?: number;
  initialDelayMs?: number;
  onError?: (error: unknown) => void;
};

/** Run one poll immediately, then only schedule another while the page is visible. */
export function createVisiblePoller(
  task: () => Promise<PollDelay> | PollDelay,
  options: VisiblePollOptions = {},
): () => void {
  const doc = options.document === undefined
    ? (typeof document === "undefined" ? null : document)
    : options.document;
  const timers = options.timers ?? globalThis;
  const errorDelayMs = options.errorDelayMs ?? 1000;
  let stopped = false;
  let hidden = doc?.hidden ?? false;
  let running = false;
  let visibleAgainDuringRun = false;
  let timer: TimerHandle | undefined;

  const clearScheduled = () => {
    if (timer !== undefined) timers.clearTimeout(timer);
    timer = undefined;
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearScheduled();
    doc?.removeEventListener("visibilitychange", onVisibilityChange);
  };

  const schedule = (delay: number) => {
    clearScheduled();
    if (stopped || hidden) return;
    timer = timers.setTimeout(() => {
      timer = undefined;
      void run();
    }, Math.max(0, delay));
  };

  const run = async () => {
    if (stopped || hidden || running) return;
    running = true;
    let nextDelay: PollDelay = errorDelayMs;
    try {
      nextDelay = await task();
    } catch (error) {
      try { options.onError?.(error); } catch { /* Keep the polling loop alive if an observer fails. */ }
    } finally {
      running = false;
    }
    if (stopped) return;
    if (nextDelay === null) {
      stop();
      return;
    }
    if (hidden) return;
    const delay = visibleAgainDuringRun ? 0 : nextDelay;
    visibleAgainDuringRun = false;
    schedule(delay);
  };

  const onVisibilityChange = () => {
    const nextHidden = doc?.hidden ?? false;
    if (nextHidden === hidden) return;
    hidden = nextHidden;
    if (hidden) {
      clearScheduled();
      return;
    }
    if (running) visibleAgainDuringRun = true;
    else void run();
  };

  doc?.addEventListener("visibilitychange", onVisibilityChange);
  if (!hidden) {
    if (options.initialDelayMs === undefined) void run();
    else schedule(options.initialDelayMs);
  }
  return stop;
}
