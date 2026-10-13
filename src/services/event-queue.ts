// The server resolves a roll atomically. Only presentation is paced here; queued
// snapshots must not overtake the step events that precede them.
export function createEventQueue<T>(apply: (event: T) => void, delayAfter: (event: T) => number) {
  const pending: T[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  function drain() {
    timer = undefined;
    while (!disposed && pending.length) {
      const event = pending.shift()!;
      apply(event);
      const delay = delayAfter(event);
      if (delay > 0) { timer = setTimeout(drain, delay); return; }
    }
  }
  return {
    push(event: T) { if (disposed) return; pending.push(event); if (!timer) drain(); },
    clear() { clearTimeout(timer); timer = undefined; pending.length = 0; },
    get isIdle() { return !timer && pending.length === 0; },
    dispose() { disposed = true; clearTimeout(timer); pending.length = 0; },
  };
}
