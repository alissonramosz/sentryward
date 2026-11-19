import type { Request, Response } from "express";
import { Prisma, type ReviewStatus, type ReviewVerdict } from "../generated/prisma/client.ts";
import { HttpError } from "../lib/httpError.ts";
import { prisma } from "../lib/prisma.ts";
import { dropRepositoriesFromTargets } from "../services/notifications.ts";
import { loadReviewConfig, repoSettingsRuleIssues, resolveDashboardLayers } from "../review/config/load.ts";
import { directorySettingsSchema, normalizeDirectory, type DashboardOverride, type DirectorySetting } from "../review/config/schema.ts";
import { hostOrigin } from "../review/forge/types.ts";
import { adapterForConnection, loadWorkspaceConnection, toHttpError } from "../services/forge.ts";
import { requireStoredLlmConnection } from "../services/llm.ts";
import { ensureWebhook, removeWebhook } from "../services/webhooks.ts";
import { cancelForDisabledRepositories, DISABLED_REASON } from "../worker/queue.ts";
import {
  addDirectorySchema,
  availableReposQuerySchema,
  directoryQuerySchema,
  enableRepoSchema,
  listReposQuerySchema,
  reorderReposSchema,
  repoConfigQuerySchema,
  repoIdParamSchema,
  updateDirectorySchema,
  updateRepoSchema,
} from "../schemas/repos.schema.ts";

const publicRepo = {
  id: true,
  connectionId: true,
  provider: true,
  host: true,
  fullPath: true,
  externalId: true,
  defaultBranch: true,
  enabled: true,
  settings: true,
  directories: true,
  followGlobal: true,
  createdAt: true,
} as const;

// The repositories a user has added. Read from the database only, so the page
// loads without asking the forge for every repository the account can see.
export async function listRepos(req: Request, res: Response) {
  const { connectionId } = listReposQuerySchema.parse(req.query);
  // Keeps the 404 for a connection the user does not own; the query below is
  // scoped by owner either way.
  if (connectionId) await loadWorkspaceConnection(req.workspaceId!, connectionId);

  const stored = await prisma.repository.findMany({
    where: { connection: { workspaceId: req.workspaceId! }, ...(connectionId && { connectionId }) },
    include: { connection: { select: { accountLogin: true, provider: true, host: true } } },
    // By path, for the pickers that share this list; the Repositories tab
    // orders by `position` itself.
    orderBy: { fullPath: "asc" },
  });
  res.json({
    repos: stored.map((repo) => ({
      id: repo.id,
      connectionId: repo.connectionId,
      account: { login: repo.connection.accountLogin, provider: repo.connection.provider, host: repo.connection.host },
      externalId: repo.externalId,
      fullPath: repo.fullPath,
      defaultBranch: repo.defaultBranch,
      webUrl: `${hostOrigin(repo.connection.host)}/${repo.fullPath}`,
      enabled: repo.enabled,
      settings: repo.settings,
      directories: repo.directories,
      followGlobal: repo.followGlobal,
      position: repo.position,
    })),
  });
}

interface LatestReviewRow {
  id: string;
  repository_id: string;
  number: number;
  status: ReviewStatus;
  verdict: ReviewVerdict | null;
  created_at: Date;
}

// Each repository's newest review in one query, rather than a nested include
// that would load every job. Skipped runs reviewed nothing and superseded ones
// were replaced by a newer run, so neither counts.
async function latestReviews(repositoryIds: string[]) {
  if (!repositoryIds.length) return new Map();
  const rows = await prisma.$queryRaw<LatestReviewRow[]>(Prisma.sql`
    SELECT DISTINCT ON (repository_id) id, repository_id, number, status, verdict, created_at
    FROM review_jobs
    WHERE repository_id = ANY(${repositoryIds}::uuid[]) AND status NOT IN ('skipped', 'superseded')
    ORDER BY repository_id, created_at DESC`);
  return new Map(
    rows.map((row) => [
      row.repository_id,
      { id: row.id, number: row.number, status: row.status, verdict: row.verdict, createdAt: row.created_at },
    ]),
  );
}

// Separate from listRepos, which the pickers share: only the Repositories tab
// shows these, so only it pays for the query.
export async function listLastReviews(req: Request, res: Response) {
  const stored = await prisma.repository.findMany({
    where: { connection: { workspaceId: req.workspaceId! } },
    select: { id: true },
  });
  const lastReviews = await latestReviews(stored.map((repo) => repo.id));
  res.json({ lastReviews: Object.fromEntries(lastReviews) });
}

export async function reorderRepos(req: Request, res: Response) {
  const { ids } = reorderReposSchema.parse(req.body);
  await prisma.$transaction(async (tx) => {
    // Locking every row up front, always by id, makes overlapping reorders
    // wait for each other instead of deadlocking on rows taken in request
    // order, and keeps the check below true until the writes commit.
    const current = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT r.id FROM repositories r
      JOIN forge_connections c ON c.id = r.connection_id
      WHERE c.workspace_id = ${req.workspaceId!}::uuid
      ORDER BY r.id
      FOR UPDATE OF r`);
    // The full set, not a subset: a repository added or removed since the page
    // loaded would otherwise land somewhere nobody chose.
    const known = new Set(current.map((repo) => repo.id));
    if (ids.length !== known.size || !ids.every((id) => known.has(id))) {
      throw new HttpError(409, "Repositories changed since the page loaded; reload and try again");
    }
    for (const [position, id] of ids.entries()) {
      await tx.repository.update({ where: { id }, data: { position } });
    }
  });
  res.status(204).end();
}

// Everything the account can see, for picking repositories to add. The forge
// is the source of truth for which repositories exist; the database only marks
// the ones already added.
export async function listAvailableRepos(req: Request, res: Response) {
  const { connectionId } = availableReposQuerySchema.parse(req.query);
  const connection = await loadWorkspaceConnection(req.workspaceId!, connectionId);

  const forgeRepos = await adapterForConnection(connection)
    .listRepos()
    .catch((err: unknown) => {
      throw toHttpError(err, connection.provider);
    });
  const stored = await prisma.repository.findMany({ where: { connectionId } });
  const byExternalId = new Map(stored.map((repo) => [repo.externalId, repo]));

  res.json({
    repos: forgeRepos.map((repo) => {
      const saved = byExternalId.get(repo.externalId);
      return { ...repo, id: saved?.id ?? null, enabled: saved?.enabled ?? false, settings: saved?.settings ?? {} };
    }),
  });
}

export async function enableRepo(req: Request, res: Response) {
  const { connectionId, externalId } = enableRepoSchema.parse(req.body);
  const connection = await loadWorkspaceConnection(req.workspaceId!, connectionId);

  const forgeRepo = await adapterForConnection(connection)
    .getRepo(externalId)
    .catch((err: unknown) => {
      throw toHttpError(err, connection.provider);
    });
  const details = { fullPath: forgeRepo.fullPath, defaultBranch: forgeRepo.defaultBranch, enabled: true, accessLostAt: null };
  const saved = await prisma.repository.upsert({
    where: { connectionId_externalId: { connectionId, externalId: forgeRepo.externalId } },
    update: details,
    create: {
      ...details,
      connectionId,
      externalId: forgeRepo.externalId,
      provider: connection.provider,
      host: connection.host,
    },
  });
  // Manual reviews work either way; the webhook only adds automatic ones.
  const webhook = await ensureWebhook(saved, connection);
  const repo = await prisma.repository.findUniqueOrThrow({ where: { id: saved.id }, select: publicRepo });
  res.status(201).json({ repo, webhook });
}

async function loadOwnedRepo(workspaceId: string, id: string) {
  const repo = await prisma.repository.findFirst({
    where: { id, connection: { workspaceId } },
    include: { connection: { include: { workspace: { select: { reviewSettings: true } } } } },
  });
  if (!repo) {
    throw new HttpError(404, "Repository not found");
  }
  return repo;
}

export async function updateRepo(req: Request, res: Response) {
  const { id } = repoIdParamSchema.parse(req.params);
  const { enabled, settings, followGlobal } = updateRepoSchema.parse(req.body);
  const existing = await loadOwnedRepo(req.workspaceId!, id);

  await requireSettingsConnection(req.workspaceId!, settings);

  // Turning a repository on or off by hand overrides any access-loss marker,
  // so a reinstall no longer flips it back.
  const accessLostAt = enabled === undefined ? undefined : null;
  // The cancel commits with the update, so a repository is never left off with
  // jobs still in flight. A job claimed just before finds it off in runJob.
  const updated = await prisma.$transaction(async (tx) => {
    if (settings !== undefined) {
      // Under the same row lock as folder changes, so a folder saved meanwhile
      // is checked against these settings too.
      await tx.$queryRaw`SELECT id FROM repositories WHERE id = ${id}::uuid FOR UPDATE`;
      const saved = await tx.repository.findUniqueOrThrow({
        where: { id },
        select: { settings: true, directories: true, followGlobal: true },
      });
      requireRepoSettingsRules(existing.connection.workspace.reviewSettings, saved, settings, followGlobal ?? saved.followGlobal);
    }
    const row = await tx.repository.update({
      where: { id },
      data: { enabled, settings, followGlobal, accessLostAt },
    });
    if (enabled === false) await cancelForDisabledRepositories([id], DISABLED_REASON, tx);
    return row;
  });
  let webhook;
  if (enabled === true) webhook = await ensureWebhook(updated, existing.connection);
  if (enabled === false) await removeWebhook(updated, existing.connection);
  const repo = await prisma.repository.findUniqueOrThrow({ where: { id }, select: publicRepo });
  res.json({ repo, ...(webhook ? { webhook } : {}) });
}

// Repository rules the layers below would leave out are refused, and so are
// folder rules these settings would newly push out (a repository rule taking
// a folder rule's id, or the combined limit), since the folder would otherwise
// lose them with only a review warning. A folder that was already broken
// before this save stays a warning, so it does not block unrelated edits.
function requireRepoSettingsRules(
  globalSettings: unknown,
  saved: { settings: unknown; directories: unknown },
  settings: DashboardOverride,
  followGlobal: boolean,
) {
  const after = repoSettingsRuleIssues({ globalSettings, repoSettings: settings, directories: saved.directories, followGlobal });
  if (!after.length) return;
  const key = (issue: { directory?: number; message: string }) => `${issue.directory}:${issue.message}`;
  const before = new Set(
    repoSettingsRuleIssues({ globalSettings, repoSettings: saved.settings, directories: saved.directories, followGlobal: false })
      .filter((issue) => issue.directory !== undefined)
      .map(key),
  );
  const issues = after.filter((issue) => issue.directory === undefined || !before.has(key(issue)));
  if (issues.length) throw new HttpError(400, "Validation failed", { rules: issues.map((issue) => issue.message) });
}

// A chosen LLM connection must be one the workspace has stored.
async function requireSettingsConnection(workspaceId: string, settings: DashboardOverride | undefined) {
  if (!settings?.llm || !("connection" in settings.llm)) return;
  if (!settings.llm.connection) {
    throw new HttpError(400, "Validation failed", { connection: ["Select an LLM connection"] });
  }
  await requireStoredLlmConnection(workspaceId, settings.llm.connection);
}

// Folders are changed one at a time, merged into the saved list under the
// repository's row lock, so two admins editing different folders (or two tabs)
// never overwrite each other with a stale copy of the whole list. `change`
// returns the new list and, when the saved folder has rules, its path: only
// that folder's rules are checked, so a folder that went stale since it was
// saved does not block edits to the others.
async function changeDirectories(
  workspaceId: string,
  id: string,
  change: (dirs: DirectorySetting[]) => { dirs: DirectorySetting[]; checkRules?: string },
) {
  const existing = await loadOwnedRepo(workspaceId, id);
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM repositories WHERE id = ${id}::uuid FOR UPDATE`;
    const row = await tx.repository.findUniqueOrThrow({
      where: { id },
      select: { settings: true, directories: true, followGlobal: true },
    });
    const current = directorySettingsSchema.safeParse(row.directories);
    if (!current.success) {
      throw new HttpError(409, "Saved folder settings are no longer valid; remove the repository's folders and add them again");
    }
    const { dirs, checkRules } = change(current.data);
    const parsed = directorySettingsSchema.safeParse(dirs);
    if (!parsed.success) {
      throw new HttpError(400, "Validation failed", { directories: parsed.error.issues.map((issue) => issue.message) });
    }
    if (checkRules !== undefined) {
      const index = parsed.data.findIndex((dir) => dir.path === checkRules);
      const issues = repoSettingsRuleIssues({
        globalSettings: existing.connection.workspace.reviewSettings,
        repoSettings: row.settings,
        directories: parsed.data,
        followGlobal: row.followGlobal,
      }).filter((issue) => issue.directory === index);
      if (issues.length) throw new HttpError(400, "Validation failed", { rules: issues.map((issue) => issue.message) });
    }
    await tx.repository.update({ where: { id }, data: { directories: parsed.data } });
  });
  return prisma.repository.findUniqueOrThrow({ where: { id }, select: publicRepo });
}

function requireDirectory(dirs: DirectorySetting[], path: string) {
  if (!dirs.some((dir) => dir.path === path)) throw new HttpError(404, "Folder not found");
}

export async function addDirectory(req: Request, res: Response) {
  const { id } = repoIdParamSchema.parse(req.params);
  const { path } = addDirectorySchema.parse(req.body);
  const repo = await changeDirectories(req.workspaceId!, id, (dirs) => ({ dirs: [...dirs, { path, settings: {} }] }));
  res.status(201).json({ repo });
}

export async function updateDirectory(req: Request, res: Response) {
  const { id } = repoIdParamSchema.parse(req.params);
  const { path, settings } = updateDirectorySchema.parse(req.body);
  await requireSettingsConnection(req.workspaceId!, settings);
  const repo = await changeDirectories(req.workspaceId!, id, (dirs) => {
    requireDirectory(dirs, path);
    return {
      dirs: dirs.map((dir) => (dir.path === path ? { path, settings } : dir)),
      checkRules: settings.rules?.length ? path : undefined,
    };
  });
  res.json({ repo });
}

export async function removeDirectory(req: Request, res: Response) {
  const { id } = repoIdParamSchema.parse(req.params);
  const { path } = directoryQuerySchema.parse(req.query);
  const repo = await changeDirectories(req.workspaceId!, id, (dirs) => {
    requireDirectory(dirs, path);
    return { dirs: dirs.filter((dir) => dir.path !== path) };
  });
  res.json({ repo });
}

// Review jobs and posted findings go with it (cascade), so re-adding the
// repository later starts without history. Notification filters drop it in the
// same step.
export async function deleteRepo(req: Request, res: Response) {
  const { id } = repoIdParamSchema.parse(req.params);
  const repo = await loadOwnedRepo(req.workspaceId!, id);
  // Take Sentryward's hook off the forge while the row still holds its id.
  await removeWebhook(repo, repo.connection).catch(() => undefined);
  await prisma.$transaction(async (tx) => {
    await dropRepositoriesFromTargets(tx, [id]);
    await tx.repository.delete({ where: { id } });
  });
  res.status(204).end();
}

// The configuration a review of the default branch would run with right now,
// with where each value came from and anything wrong with the repository file.
export async function getRepoConfig(req: Request, res: Response) {
  const { id } = repoIdParamSchema.parse(req.params);
  const { directory } = repoConfigQuerySchema.parse(req.query);
  const repo = await loadOwnedRepo(req.workspaceId!, id);

  const loaded = await loadReviewConfig({
    adapter: adapterForConnection(repo.connection),
    project: repo.fullPath,
    ref: repo.defaultBranch,
    globalSettings: repo.connection.workspace.reviewSettings,
    repoSettings: repo.settings,
    directories: repo.directories,
    directory,
    followGlobal: repo.followGlobal,
  }).catch((err: unknown) => {
    throw toHttpError(err, repo.provider);
  });
  // A folder for which the saved list has no entry would otherwise silently
  // show the repository's config. One that exists while the repository
  // follows the global config is ignored by reviews, so `directory` is null.
  if (directory) {
    const saved = directorySettingsSchema.safeParse(repo.directories);
    const name = normalizeDirectory(directory);
    if (!saved.success || !saved.data.some((dir) => dir.path === name)) throw new HttpError(404, "Folder not found");
  }
  // What the folder inherits, without the repository file (which sits above
  // it), so the folder form checks rules and shows Inherit values as a review
  // would resolve them.
  const inherited = directory
    ? resolveDashboardLayers({
        globalSettings: repo.connection.workspace.reviewSettings,
        repoSettings: repo.settings,
        followGlobal: repo.followGlobal,
      })
    : undefined;
  res.json({
    ref: repo.defaultBranch,
    ...loaded,
    ...(inherited ? { inherited: { config: inherited.config, sources: inherited.sources } } : {}),
  });
}

// Open pull/merge requests, for picking one to review by hand. Read live from
// the forge; Sentryward only knows about changes it has already reviewed.
export async function listRepoChanges(req: Request, res: Response) {
  const { id } = repoIdParamSchema.parse(req.params);
  const repo = await loadOwnedRepo(req.workspaceId!, id);

  const changes = await adapterForConnection(repo.connection)
    .listOpenChanges(repo.fullPath)
    .catch((err: unknown) => {
      throw toHttpError(err, repo.provider);
    });
  res.json({ changes });
}
