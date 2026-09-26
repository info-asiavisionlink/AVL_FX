/** Canonical execution-command expiry policy. All timestamps are absolute UTC. */
export const COMMAND_EXPIRY_SECONDS = 300;

export function createCommandExpiryUtc(now: Date = new Date()): string {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("Invalid UTC clock value");
  return new Date(now.getTime() + COMMAND_EXPIRY_SECONDS * 1000).toISOString();
}

/** Invalid or missing expiry is fail-closed; expiry is inclusive at the boundary. */
export function isCommandExpired(expiresAt: string | null | undefined, now: Date = new Date()): boolean {
  if (!expiresAt || !(now instanceof Date) || !Number.isFinite(now.getTime())) return true;
  const expiryMs = Date.parse(expiresAt);
  return !Number.isFinite(expiryMs) || now.getTime() >= expiryMs;
}
