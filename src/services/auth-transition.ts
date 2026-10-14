export function shouldReconcileAuthIdentity({
  currentOwnerId,
  nextOwnerId,
  event,
  hasGuestIdentity = false,
}: {
  currentOwnerId: string | null;
  nextOwnerId: string | null;
  event: string;
  hasGuestIdentity?: boolean;
}): boolean {
  if (event === "SIGNED_OUT") return true;
  if (event === "PASSWORD_RECOVERY") return false;
  if (currentOwnerId === nextOwnerId) return false;
  if (currentOwnerId !== null) return true;
  if (nextOwnerId === null) return false;
  if (event === "INITIAL_SESSION" && !hasGuestIdentity) return false;
  return true;
}
