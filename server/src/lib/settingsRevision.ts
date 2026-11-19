import { createHash } from "node:crypto";

// A revision of saved review settings, taken from their content: a settings
// form sends back the one it loaded, and a save whose revision no longer
// matches is refused, so a form left open cannot overwrite a rule added since
// (an approved rule suggestion, or another admin's save) with its stale copy.
// Content rather than updated_at, which unrelated columns on the same row
// (such as the worker's rule suggestion run times) also move. Stable across
// reads because jsonb stores an object's keys in a fixed order.
export function settingsRevision(saved: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(saved ?? {}))
    .digest("hex")
    .slice(0, 16);
}
