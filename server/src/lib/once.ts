// Runs an async lookup at most once, however many callers ask. Used where one
// webhook delivery feeds several handlers that each may need the same forge
// call; a failure is shared too, so it is not retried within the delivery.
export function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let result: Promise<T> | undefined;
  return () => (result ??= fn());
}
