export function createTimeoutSignal(timeoutMs = 20000) {
  return AbortSignal.timeout(timeoutMs);
}
