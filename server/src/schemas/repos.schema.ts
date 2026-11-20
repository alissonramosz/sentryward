import { z } from "zod";
import { dashboardOverrideSchema, directoryPathSchema } from "../review/config/schema.ts";

// Without a connectionId, lists the added repositories of every connection.
export const listReposQuerySchema = z.object({
  connectionId: z.uuid().optional(),
});

export const availableReposQuerySchema = z.object({
  connectionId: z.uuid(),
});

// Every added repository in the workspace, in the order to show them.
export const reorderReposSchema = z.object({
  ids: z
    .array(z.uuid())
    .min(1)
    .refine((ids) => new Set(ids).size === ids.length, "Each repository may appear only once"),
});

export const enableRepoSchema = z.object({
  connectionId: z.uuid(),
  externalId: z.string().min(1),
});

// `settings` replaces the saved overrides as a whole; an empty object resets
// the repository to the global config, its profile and the defaults. Folders
// are changed one at a time through /directories instead, so two admins
// editing different folders never overwrite each other. `settingsRevision`
// is the one the form loaded: a save made after the settings changed is
// refused (lib/settingsRevision.ts). Required with `settings`, as a write
// without one could replace a rule approved since the caller read them; the
// controller enforces that with a 409 "reload" answer, so a page loaded before
// revisions existed is told to reload instead of failing validation.
export const updateRepoSchema = z
  .object({
    enabled: z.boolean().optional(),
    settings: dashboardOverrideSchema.optional(),
    settingsRevision: z.string().max(64).optional(),
    followGlobal: z.boolean().optional(),
  })
  .refine((body) => body.enabled !== undefined || body.settings !== undefined || body.followGlobal !== undefined, {
    message: "Provide enabled, settings or followGlobal",
    path: ["enabled"],
  });

export const repoIdParamSchema = z.object({ id: z.uuid() });

// Which folder's effective config to show; none means the repository's.
export const repoConfigQuerySchema = z.object({ directory: z.string().min(1).max(300).optional() });

// A new folder starts with no settings of its own.
export const addDirectorySchema = z.object({ path: directoryPathSchema });

// `settings` replaces the folder's saved overrides as a whole.
export const updateDirectorySchema = z.object({ path: directoryPathSchema, settings: dashboardOverrideSchema });

export const directoryQuerySchema = z.object({ path: directoryPathSchema });
