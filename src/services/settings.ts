export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function readStoredSetting(key: string, legacyKey: string, storage: StorageLike): string | null {
  try {
    const v = storage.getItem(key);
    if (v !== null) return v;
    const old = storage.getItem(legacyKey);
    if (old !== null) {
      storage.setItem(key, old);
      storage.removeItem(legacyKey);
      return old;
    }
  } catch {
    return null;
  }
  return null;
}

export function resolveQuality(saved: string | null, width: number): "low" | "high" {
  if (saved === "low" || saved === "high") return saved;
  return width < 768 ? "low" : "high";
}

export function resolveReducedMotion(saved: string | null, osPrefersReduce: boolean): boolean {
  if (saved === "true") return true;
  if (saved === "false") return false;
  return osPrefersReduce;
}
