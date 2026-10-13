let offset = 0;
export function setServerTime(serverTime: string) {
  const parsed = Date.parse(serverTime);
  if (Number.isFinite(parsed)) offset = parsed - Date.now();
}
export function serverNow() { return Date.now() + offset; }
