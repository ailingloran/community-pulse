/** In-memory state updated each time a collection run starts. */
let _lastAttemptedAt: string | null = null;

export function markCollectionAttempt(): void {
  _lastAttemptedAt = new Date().toISOString();
}

export function getLastAttemptedAt(): string | null {
  return _lastAttemptedAt;
}
