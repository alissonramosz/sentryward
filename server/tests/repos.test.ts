import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app.ts";
import { decrypt, encrypt } from "../src/lib/crypto.ts";
import { settingsRevision } from "../src/lib/settingsRevision.ts";
import { prisma } from "../src/lib/prisma.ts";
import { ensureWebhook, webhookUrl } from "../src/services/webhooks.ts";
import { fetchStub } from "./helpers/fetchStub.ts";
import { addMember, createTeam, createUser, inWorkspace } from "./helpers/users.ts";

let cookie: string;
let connectionId: string;

// Settings saves must send the revision they were read at. Tests that are not
// about concurrent saves read the current one just before saving.
async function globalRevision(): Promise<string> {
  const res = await request(app).get("/api/config/global").set("Cookie", cookie);
  return res.body.revision;
}

async function repoRevision(id: string): Promise<string> {
  const repo = await prisma.repository.findUniqueOrThrow({ where: { id }, select: { settings: true } });
  return settingsRevision(repo.settings);
}

const project = (id: number, path: string) => ({
  id,
  path_with_namespace: path,
  default_branch: "main",
  visibility: "private",
  web_url: `https://gitlab.com/${path}`,
});

beforeEach(async () => {
  await prisma.workspace.deleteMany();
  await prisma.user.deleteMany();
  const created = await createUser();
  cookie = created.cookie;
  const connection = await prisma.forgeConnection.create({
    data: {
      workspaceId: created.workspace.id,
      provider: "gitlab",
      host: "gitlab.com",
      kind: "token",
      accountLogin: "dev",
      encryptedToken: encrypt("glpat"),
    },
  });
  connectionId = connection.id;
  await prisma.llmCredential.create({
    data: { workspaceId: created.workspace.id, provider: "openai", encryptedKey: encrypt("sk-openai-test") },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("GET /api/repos", () => {
  it("lists only the added repositories, without asking the forge", async () => {
    await prisma.repository.create({
      data: {
        connectionId,
        provider: "gitlab",
        host: "gitlab.com",
        fullPath: "team/api",
        externalId: "2",
        defaultBranch: "main",
        enabled: true,
      },
    });
    // No routes: any forge request would throw.
    vi.stubGlobal("fetch", fetchStub([]).fetch);

    const res = await request(app).get(`/api/repos?connectionId=${connectionId}`).set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.repos).toEqual([
      expect.objectContaining({
        externalId: "2",
        fullPath: "team/api",
        enabled: true,
        settings: {},
        webUrl: "https://gitlab.com/team/api",
      }),
    ]);
  });

  it("404s for another user's connection", async () => {
    const other = await createUser("other@example.com");
    const res = await request(app).get(`/api/repos?connectionId=${connectionId}`).set("Cookie", other.cookie);
    expect(res.status).toBe(404);
  });
  it("lists every connection's repositories when no connectionId is given", async () => {
    const workspaceId = (await prisma.forgeConnection.findUniqueOrThrow({ where: { id: connectionId } })).workspaceId;
    const second = await prisma.forgeConnection.create({
      data: { workspaceId, provider: "gitlab", host: "gitlab.acme.com", kind: "token", accountLogin: "work", encryptedToken: encrypt("glpat") },
    });
    const other = await createUser("other@example.com");
    const foreign = await prisma.forgeConnection.create({
      data: { workspaceId: other.workspace.id, provider: "gitlab", host: "gitlab.com", kind: "token", accountLogin: "x", encryptedToken: encrypt("glpat") },
    });
    const repo = (connection: string, fullPath: string, externalId: string) => ({
      connectionId: connection,
      provider: "gitlab" as const,
      host: "gitlab.com",
      fullPath,
      externalId,
      defaultBranch: "main",
    });
    await prisma.repository.createMany({
      data: [repo(connectionId, "team/web", "1"), repo(second.id, "acme/api", "2"), repo(foreign.id, "other/secret", "3")],
    });

    const res = await request(app).get("/api/repos").set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.repos).toEqual([
      expect.objectContaining({
        fullPath: "acme/api",
        connectionId: second.id,
        account: { login: "work", provider: "gitlab", host: "gitlab.acme.com" },
        webUrl: "https://gitlab.acme.com/acme/api",
      }),
      expect.objectContaining({ fullPath: "team/web", connectionId, account: { login: "dev", provider: "gitlab", host: "gitlab.com" } }),
    ]);
  });
});

describe("repository order and latest review", () => {
  const addRepo = (fullPath: string, connection = connectionId) =>
    prisma.repository.create({
      data: { connectionId: connection, provider: "gitlab", host: "gitlab.com", fullPath, externalId: fullPath, defaultBranch: "main" },
    });
  const listed = async () => (await request(app).get("/api/repos").set("Cookie", cookie)).body.repos;
  const reorder = (ids: string[]) => request(app).put("/api/repos/order").set("Cookie", cookie).send({ ids });

  it("returns each repository's newest review that ran, or null", async () => {
    const api = await addRepo("team/api");
    await addRepo("team/web");
    const job = (status: "completed" | "skipped" | "superseded" | "running", number: number, createdAt: string) =>
      prisma.reviewJob.create({
        data: { repositoryId: api.id, number, headSha: "h", trigger: "manual", status, createdAt: new Date(createdAt) },
      });
    await job("completed", 1, "2026-01-01");
    const newest = await job("running", 2, "2026-01-02");
    await job("skipped", 3, "2026-01-03");
    await job("superseded", 4, "2026-01-04");

    const res = await request(app).get("/api/repos/last-reviews").set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.lastReviews).toEqual({
      [api.id]: { id: newest.id, number: 2, status: "running", verdict: null, createdAt: "2026-01-02T00:00:00.000Z" },
    });
    // The shared list leaves them to the endpoint above.
    expect((await listed())[0]).not.toHaveProperty("lastReview");
  });

  it("saves an order the list reports as position, keeping it sorted by path", async () => {
    const a = await addRepo("team/a");
    const b = await addRepo("team/b");
    const c = await addRepo("team/c");

    expect((await reorder([c.id, a.id, b.id])).status).toBe(204);

    const repos = await listed();
    expect(repos.map((repo: { fullPath: string; position: number }) => [repo.fullPath, repo.position])).toEqual([
      ["team/a", 1],
      ["team/b", 2],
      ["team/c", 0],
    ]);
  });

  it("lets overlapping reorders finish one after the other", async () => {
    const repos = await Promise.all(["team/a", "team/b", "team/c", "team/d"].map((path) => addRepo(path)));
    const ids = repos.map((repo) => repo.id);

    const results = await Promise.all([reorder(ids), reorder([...ids].reverse())]);

    expect(results.map((res) => res.status)).toEqual([204, 204]);
    const positions = (await listed()).map((repo: { position: number }) => repo.position);
    expect([[0, 1, 2, 3], [3, 2, 1, 0]]).toContainEqual(positions);
  });

  it("409s unless the ids are exactly the workspace's repositories", async () => {
    const other = await createUser("other@example.com");
    const foreign = await prisma.forgeConnection.create({
      data: { workspaceId: other.workspace.id, provider: "gitlab", host: "gitlab.com", kind: "token", accountLogin: "x" },
    });
    const a = await addRepo("team/a");
    const b = await addRepo("team/b");
    const theirs = await addRepo("them/x", foreign.id);

    expect((await reorder([a.id])).status).toBe(409);
    expect((await reorder([a.id, b.id, theirs.id])).status).toBe(409);
    expect((await reorder([a.id, theirs.id])).status).toBe(409);
    expect((await reorder([a.id, a.id])).status).toBe(400);
    const stored = await prisma.repository.findMany({ select: { position: true } });
    expect(stored.every((repo) => repo.position === null)).toBe(true);
  });

  it("refuses workspace members who are not admins", async () => {
    const owner = await createUser("owner@example.com");
    const team = await createTeam(owner.user.id, "Acme");
    const me = await prisma.user.findUniqueOrThrow({ where: { email: "dev@example.com" } });
    await addMember(team.id, me.id, "member");
    const teamConnection = await prisma.forgeConnection.create({
      data: { workspaceId: team.id, provider: "gitlab", host: "gitlab.com", kind: "token", accountLogin: "acme" },
    });
    const repo = await addRepo("acme/api", teamConnection.id);

    const res = await request(app)
      .put("/api/repos/order")
      .set("Cookie", cookie)
      .set(...inWorkspace(team.id))
      .send({ ids: [repo.id] });

    expect(res.status).toBe(403);
    expect((await prisma.repository.findUniqueOrThrow({ where: { id: repo.id } })).position).toBeNull();
  });
});

describe("GET /api/repos/available", () => {
  it("merges the forge's list with what is enabled", async () => {
    await prisma.repository.create({
      data: {
        connectionId,
        provider: "gitlab",
        host: "gitlab.com",
        fullPath: "team/api",
        externalId: "2",
        defaultBranch: "main",
        enabled: true,
      },
    });
    vi.stubGlobal(
      "fetch",
      fetchStub([{ url: /\/api\/v4\/projects\?membership=true/, body: [project(1, "team/web"), project(2, "team/api")] }])
        .fetch,
    );

    const res = await request(app).get(`/api/repos/available?connectionId=${connectionId}`).set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.repos.map((r: { fullPath: string; enabled: boolean }) => [r.fullPath, r.enabled])).toEqual([
      ["team/web", false],
      ["team/api", true],
    ]);
    expect(res.body.repos[0].settings).toEqual({});
  });

  it("reports revoked credentials as a broken connection", async () => {
    vi.stubGlobal("fetch", fetchStub([{ url: /\/projects\?/, status: 401, body: { message: "401" } }]).fetch);

    const res = await request(app).get(`/api/repos/available?connectionId=${connectionId}`).set("Cookie", cookie);

    expect(res.status).toBe(502);
    expect(res.body.message).toBe("GitLab rejected the stored credentials; reconnect the account");
  });

  it("404s for another user's connection", async () => {
    const other = await createUser("other@example.com");
    const res = await request(app).get(`/api/repos/available?connectionId=${connectionId}`).set("Cookie", other.cookie);
    expect(res.status).toBe(404);
  });
});

describe("POST /api/repos and PATCH /api/repos/:id", () => {
  it("enables a repository from the forge, then toggles it", async () => {
    vi.stubGlobal("fetch", fetchStub([{ url: /\/api\/v4\/projects\/1$/, body: project(1, "team/web") }]).fetch);

    const created = await request(app)
      .post("/api/repos")
      .set("Cookie", cookie)
      .send({ connectionId, externalId: "1" });

    expect(created.status).toBe(201);
    expect(created.body.repo).toMatchObject({ fullPath: "team/web", enabled: true, provider: "gitlab" });

    const again = await request(app).post("/api/repos").set("Cookie", cookie).send({ connectionId, externalId: "1" });
    expect(again.body.repo.id).toBe(created.body.repo.id);

    const patched = await request(app)
      .patch(`/api/repos/${created.body.repo.id}`)
      .set("Cookie", cookie)
      .send({ enabled: false });
    expect(patched.status).toBe(200);
    expect(patched.body.repo.enabled).toBe(false);
  });

  it("404s when the forge does not know the repository", async () => {
    vi.stubGlobal("fetch", fetchStub([{ url: /\/projects\/404$/, status: 404, body: {} }]).fetch);

    const res = await request(app).post("/api/repos").set("Cookie", cookie).send({ connectionId, externalId: "404" });

    expect(res.status).toBe(404);
  });

  it("saves validated settings and resets them with an empty object", async () => {
    const repo = await prisma.repository.create({
      data: { connectionId, provider: "gitlab", host: "gitlab.com", fullPath: "team/web", externalId: "1", defaultBranch: "main" },
    });

    const saved = await request(app)
      .patch(`/api/repos/${repo.id}`)
      .set("Cookie", cookie)
      .send({ settings: { profile: "strict", review: { maxFindings: 10 } }, settingsRevision: await repoRevision(repo.id) });
    expect(saved.status).toBe(200);
    expect(saved.body.repo.settings).toEqual({ profile: "strict", review: { maxFindings: 10 } });
    expect(saved.body.repo.enabled).toBe(false);

    const reset = await request(app).patch(`/api/repos/${repo.id}`).set("Cookie", cookie).send({ settings: {}, settingsRevision: await repoRevision(repo.id) });
    expect(reset.body.repo.settings).toEqual({});
  });

  it("toggles following the global config, keeping the saved settings", async () => {
    const repo = await prisma.repository.create({
      data: {
        connectionId,
        provider: "gitlab",
        host: "gitlab.com",
        fullPath: "team/web",
        externalId: "1",
        defaultBranch: "main",
        settings: { profile: "strict" },
      },
    });
    expect(repo.followGlobal).toBe(true);

    const res = await request(app).patch(`/api/repos/${repo.id}`).set("Cookie", cookie).send({ followGlobal: false });

    expect(res.status).toBe(200);
    expect(res.body.repo).toMatchObject({ followGlobal: false, settings: { profile: "strict" } });
  });

  it("rejects invalid settings and an empty body", async () => {
    const repo = await prisma.repository.create({
      data: { connectionId, provider: "gitlab", host: "gitlab.com", fullPath: "team/web", externalId: "1", defaultBranch: "main" },
    });

    const bad = await request(app)
      .patch(`/api/repos/${repo.id}`)
      .set("Cookie", cookie)
      .send({ settings: { review: { blockOn: "blocker" }, llm: { apiBase: "https://evil" } }, settingsRevision: await repoRevision(repo.id) });
    expect(bad.status).toBe(400);
    expect(bad.body.errors.settings).toBeDefined();

    const empty = await request(app).patch(`/api/repos/${repo.id}`).set("Cookie", cookie).send({});
    expect(empty.status).toBe(400);
  });

  it("will not let another user toggle the repository", async () => {
    const repo = await prisma.repository.create({
      data: {
        connectionId,
        provider: "gitlab",
        host: "gitlab.com",
        fullPath: "team/web",
        externalId: "1",
        defaultBranch: "main",
      },
    });
    const other = await createUser("other@example.com");

    const res = await request(app).patch(`/api/repos/${repo.id}`).set("Cookie", other.cookie).send({ enabled: true });

    expect(res.status).toBe(404);
  });

  it("cancels the repository's queued and running reviews when it is turned off", async () => {
    const repoData = { connectionId, provider: "gitlab" as const, host: "gitlab.com", defaultBranch: "main", enabled: true };
    const repo = await prisma.repository.create({ data: { ...repoData, fullPath: "team/web", externalId: "1" } });
    const other = await prisma.repository.create({ data: { ...repoData, fullPath: "team/api", externalId: "2" } });
    const jobOf = (repositoryId: string, number: number, status: "queued" | "running" | "completed") =>
      prisma.reviewJob.create({ data: { repositoryId, number, headSha: `h${number}`, trigger: "webhook", status } });
    const queued = await jobOf(repo.id, 1, "queued");
    const running = await jobOf(repo.id, 2, "running");
    const done = await jobOf(repo.id, 3, "completed");
    const elsewhere = await jobOf(other.id, 4, "queued");

    // Settings alone leave the jobs alone.
    await request(app).patch(`/api/repos/${repo.id}`).set("Cookie", cookie).send({ settings: { profile: "strict" }, settingsRevision: await repoRevision(repo.id) });
    expect(await prisma.reviewJob.count({ where: { status: "cancelled" } })).toBe(0);

    const res = await request(app).patch(`/api/repos/${repo.id}`).set("Cookie", cookie).send({ enabled: false });
    expect(res.status).toBe(200);

    const statuses = await prisma.reviewJob.findMany({ select: { id: true, status: true, error: true } });
    const byId = Object.fromEntries(statuses.map((job) => [job.id, job]));
    for (const id of [queued.id, running.id]) {
      expect(byId[id]).toMatchObject({ status: "cancelled", error: "Reviews were turned off for this repository" });
    }
    expect(byId[done.id]!.status).toBe("completed");
    expect(byId[elsewhere.id]!.status).toBe("queued");
  });
});

describe("DELETE /api/repos/:id", () => {
  it("removes the repository and its GitLab hook", async () => {
    const repo = await prisma.repository.create({
      data: {
        connectionId,
        provider: "gitlab",
        host: "gitlab.com",
        fullPath: "team/api",
        externalId: "1",
        defaultBranch: "main",
        enabled: true,
        webhookId: "314",
        encryptedWebhookSecret: encrypt("secret"),
      },
    });
    const stub = fetchStub([{ method: "DELETE", url: /\/api\/v4\/projects\/1\/hooks\/314$/, status: 204, body: "" }]);
    vi.stubGlobal("fetch", stub.fetch);

    const res = await request(app).delete(`/api/repos/${repo.id}`).set("Cookie", cookie);

    expect(res.status).toBe(204);
    expect(stub.calls.map((call) => call.method)).toEqual(["DELETE"]);
    expect(await prisma.repository.findUnique({ where: { id: repo.id } })).toBeNull();
  });

  it("404s for another user's repository", async () => {
    const repo = await prisma.repository.create({
      data: { connectionId, provider: "gitlab", host: "gitlab.com", fullPath: "team/api", externalId: "1", defaultBranch: "main" },
    });
    const other = await createUser("other@example.com");

    const res = await request(app).delete(`/api/repos/${repo.id}`).set("Cookie", other.cookie);

    expect(res.status).toBe(404);
    expect(await prisma.repository.findUnique({ where: { id: repo.id } })).not.toBeNull();
  });
});

describe("GET /api/repos/:id/config", () => {
  it("resolves saved settings with the repository file from the default branch", async () => {
    const repo = await prisma.repository.create({
      data: {
        connectionId,
        provider: "gitlab",
        host: "gitlab.com",
        fullPath: "team/web",
        externalId: "1",
        defaultBranch: "trunk",
        settings: { review: { maxFindings: 10 } },
        followGlobal: false,
      },
    });
    const { fetch, calls } = fetchStub([
      { url: /\/repository\/files\/\.sentryward\.yaml\/raw\?ref=trunk$/, body: "profile: security\noutput:\n  post_check: false\n" },
    ]);
    vi.stubGlobal("fetch", fetch);

    const res = await request(app).get(`/api/repos/${repo.id}/config`).set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ref: "trunk", repoFile: ".sentryward.yaml", warnings: [] });
    expect(res.body.config.profile).toBe("security");
    expect(res.body.config.review.maxFindings).toBe(10);
    expect(res.body.config.output.postCheck).toBe(false);
    expect(res.body.sources).toMatchObject({
      profile: "repoFile",
      "review.maxFindings": "repoSettings",
      "review.blockOn": "profile",
    });
    expect(calls).toHaveLength(1);
  });

  it("404s for another user's repository", async () => {
    const repo = await prisma.repository.create({
      data: { connectionId, provider: "gitlab", host: "gitlab.com", fullPath: "team/web", externalId: "1", defaultBranch: "main" },
    });
    const other = await createUser("other@example.com");

    const res = await request(app).get(`/api/repos/${repo.id}/config`).set("Cookie", other.cookie);

    expect(res.status).toBe(404);
  });
});

describe("GET /api/repos/:id/changes", () => {
  it("lists the repository's open merge requests from the forge", async () => {
    const repo = await prisma.repository.create({
      data: { connectionId, provider: "gitlab", host: "gitlab.com", fullPath: "team/web", externalId: "1", defaultBranch: "main" },
    });
    vi.stubGlobal(
      "fetch",
      fetchStub([
        {
          url: /\/projects\/team%2Fweb\/merge_requests\?state=opened/,
          body: [
            {
              iid: 4,
              title: "Add search",
              draft: false,
              sha: "h4",
              state: "opened",
              web_url: "https://gitlab.com/team/web/-/merge_requests/4",
              updated_at: "2026-10-01T00:00:00Z",
              author: { username: "dev" },
              source_branch: "search",
              target_branch: "main",
            },
          ],
        },
      ]).fetch,
    );

    const res = await request(app).get(`/api/repos/${repo.id}/changes`).set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.changes).toEqual([
      expect.objectContaining({ number: 4, title: "Add search", headSha: "h4", sourceBranch: "search", author: "dev" }),
    ]);
  });

  it("404s for another user's repository", async () => {
    const repo = await prisma.repository.create({
      data: { connectionId, provider: "gitlab", host: "gitlab.com", fullPath: "team/web", externalId: "1", defaultBranch: "main" },
    });
    const other = await createUser("other@example.com");

    const res = await request(app).get(`/api/repos/${repo.id}/changes`).set("Cookie", other.cookie);

    expect(res.status).toBe(404);
  });
});

describe("GET /api/repos/:id/config with the global config", () => {
  async function repoWithGlobal(followGlobal: boolean) {
    const connection = await prisma.forgeConnection.findUniqueOrThrow({ where: { id: connectionId } });
    await prisma.workspace.update({
      where: { id: connection.workspaceId },
      data: { reviewSettings: { profile: "security", review: { maxFindings: 5, minConfidence: 0.9 } } },
    });
    const repo = await prisma.repository.create({
      data: {
        connectionId,
        provider: "gitlab",
        host: "gitlab.com",
        fullPath: "team/web",
        externalId: "1",
        defaultBranch: "main",
        settings: { review: { maxFindings: 10 } },
        followGlobal,
      },
    });
    vi.stubGlobal("fetch", fetchStub([{ url: /\/repository\/files\/.+\/raw/, status: 404, body: "" }]).fetch);
    return repo;
  }

  it("uses only the global config while the repository follows it", async () => {
    const repo = await repoWithGlobal(true);

    const res = await request(app).get(`/api/repos/${repo.id}/config`).set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.config.profile).toBe("security");
    expect(res.body.config.review.maxFindings).toBe(5);
    expect(res.body.sources).toMatchObject({ profile: "global", "review.maxFindings": "global" });
  });

  it("combines rules from every layer and reports a repository file rule that clashes with a workspace rule", async () => {
    const connection = await prisma.forgeConnection.findUniqueOrThrow({ where: { id: connectionId } });
    const workspaceRule = { id: "no-secrets", description: "Never log secrets.", severity: "critical" };
    await prisma.workspace.update({ where: { id: connection.workspaceId }, data: { reviewSettings: { rules: [workspaceRule] } } });
    const repo = await prisma.repository.create({
      data: {
        connectionId,
        provider: "gitlab",
        host: "gitlab.com",
        fullPath: "team/web",
        externalId: "1",
        defaultBranch: "main",
        settings: { rules: [{ id: "repo-rule", description: "Repo.", severity: "minor" }] },
        followGlobal: false,
      },
    });
    vi.stubGlobal(
      "fetch",
      fetchStub([
        {
          url: /\/repository\/files\/\.sentryward\.yaml\/raw\?ref=main$/,
          body: "rules:\n  - id: no-secrets\n    description: Logging secrets is fine.\n    severity: info\n  - id: file-rule\n    description: File.\n    severity: major\n",
        },
      ]).fetch,
    );

    const res = await request(app).get(`/api/repos/${repo.id}/config`).set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.config.rules.map((rule: { id: string }) => rule.id)).toEqual(["no-secrets", "repo-rule", "file-rule"]);
    expect(res.body.config.rules[0]).toEqual(workspaceRule);
    expect(res.body.sources).toMatchObject({
      "rules.no-secrets": "global",
      "rules.repo-rule": "repoSettings",
      "rules.file-rule": "repoFile",
    });
    expect(res.body.warnings).toEqual([
      "Rule no-secrets in the repository file was ignored: a rule with that id is already set in the global config",
    ]);
  });

  it("layers the repository settings over the global config when it does not", async () => {
    const repo = await repoWithGlobal(false);

    const res = await request(app).get(`/api/repos/${repo.id}/config`).set("Cookie", cookie);

    expect(res.body.config.review.maxFindings).toBe(10);
    expect(res.body.config.review.minConfidence).toBe(0.9);
    expect(res.body.sources).toMatchObject({ "review.maxFindings": "repoSettings", "review.minConfidence": "global" });
  });
});

describe("GET and PUT /api/config/global", () => {
  it("starts empty, saves validated settings and resets while keeping the connection", async () => {
    const initial = await request(app).get("/api/config/global").set("Cookie", cookie);
    expect(initial.status).toBe(200);
    expect(initial.body).toMatchObject({ settings: {}, warnings: [], sources: { profile: "default" } });

    const saved = await request(app)
      .put("/api/config/global")
      .set("Cookie", cookie)
      .send({ settings: { profile: "strict", llm: { model: "openai/gpt-5", connection: "openai" } }, revision: await globalRevision() });
    expect(saved.status).toBe(200);
    expect(saved.body.settings).toEqual({
      profile: "strict",
      llm: { model: "openai/gpt-5", connection: "openai" },
    });
    expect(saved.body.config.review.blockOn).toBe("major");
    expect(saved.body.sources).toMatchObject({ profile: "global", "llm.model": "global", "review.blockOn": "profile" });

    const reset = await request(app)
      .put("/api/config/global")
      .set("Cookie", cookie)
      .send({ settings: { llm: { connection: "openai" } }, revision: await globalRevision() });
    expect(reset.body.settings).toEqual({ llm: { connection: "openai" } });
  });

  it("refuses a save made from settings that changed since they were read", async () => {
    const read = await request(app).get("/api/config/global").set("Cookie", cookie);
    expect(read.body.revision).toEqual(expect.any(String));

    const first = await request(app)
      .put("/api/config/global")
      .set("Cookie", cookie)
      .send({ settings: { llm: { connection: "openai" }, profile: "strict" }, revision: read.body.revision });
    expect(first.status).toBe(200);
    expect(first.body.revision).not.toBe(read.body.revision);

    const stale = await request(app)
      .put("/api/config/global")
      .set("Cookie", cookie)
      .send({ settings: { llm: { connection: "openai" } }, revision: read.body.revision });
    expect(stale.status).toBe(409);
    const workspace = await prisma.workspace.findFirstOrThrow({ where: { connections: { some: { id: connectionId } } } });
    expect(workspace.reviewSettings).toEqual({ llm: { connection: "openai" }, profile: "strict" });

    // Stable across reads, and required: a save without one could replace a
    // rule approved since the caller read the settings.
    const again = await request(app).get("/api/config/global").set("Cookie", cookie);
    expect(again.body.revision).toBe(first.body.revision);
    const unchecked = await request(app)
      .put("/api/config/global")
      .set("Cookie", cookie)
      .send({ settings: { llm: { connection: "openai" } } });
    expect(unchecked.status).toBe(400);
    expect(unchecked.body.errors.revision).toBeDefined();
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } })).reviewSettings).toEqual({
      llm: { connection: "openai" },
      profile: "strict",
    });
  });

  it("refuses a repository settings save made from settings that changed since they were read", async () => {
    const repo = await prisma.repository.create({
      data: { connectionId, provider: "gitlab", host: "gitlab.com", fullPath: "team/stale", externalId: "11", defaultBranch: "main", followGlobal: false },
    });
    const listed = await request(app).get("/api/repos").set("Cookie", cookie);
    const loaded = listed.body.repos.find((row: { id: string }) => row.id === repo.id).settingsRevision;
    expect(loaded).toEqual(expect.any(String));

    const first = await request(app)
      .patch(`/api/repos/${repo.id}`)
      .set("Cookie", cookie)
      .send({ settings: { profile: "strict" }, settingsRevision: loaded });
    expect(first.status).toBe(200);
    expect(first.body.repo.settingsRevision).not.toBe(loaded);

    const stale = await request(app)
      .patch(`/api/repos/${repo.id}`)
      .set("Cookie", cookie)
      .send({ settings: {}, settingsRevision: loaded });
    expect(stale.status).toBe(409);
    expect((await prisma.repository.findUniqueOrThrow({ where: { id: repo.id } })).settings).toEqual({ profile: "strict" });

    // Required with settings, but not to turn the repository on or off.
    const unchecked = await request(app).patch(`/api/repos/${repo.id}`).set("Cookie", cookie).send({ settings: {} });
    expect(unchecked.status).toBe(400);
    expect(unchecked.body.errors.settingsRevision).toBeDefined();
    expect((await prisma.repository.findUniqueOrThrow({ where: { id: repo.id } })).settings).toEqual({ profile: "strict" });
    const toggled = await request(app).patch(`/api/repos/${repo.id}`).set("Cookie", cookie).send({ followGlobal: true });
    expect(toggled.status).toBe(200);
  });

  it("rejects invalid settings", async () => {
    const res = await request(app)
      .put("/api/config/global")
      .set("Cookie", cookie)
      .send({ settings: { llm: { apiBase: "https://evil" } }, revision: await globalRevision() });

    expect(res.status).toBe(400);
    expect(res.body.errors.settings).toBeDefined();
  });

  it("saves rules in the global config and repository settings, validated like the file", async () => {
    const rules = [{ id: "no-b", description: "No b.", severity: "major", pattern: "\\bb\\b" }];
    const global = await request(app)
      .put("/api/config/global")
      .set("Cookie", cookie)
      .send({ settings: { llm: { connection: "openai" }, rules }, revision: await globalRevision() });
    expect(global.status).toBe(200);
    expect(global.body.settings.rules).toEqual(rules);
    expect(global.body.config.rules).toEqual(rules);
    expect(global.body.sources).toMatchObject({ rules: "global", "rules.no-b": "global" });

    const read = await request(app).get("/api/config/global").set("Cookie", cookie);
    expect(read.body.settings.rules).toEqual(rules);

    const lookahead = await request(app)
      .put("/api/config/global")
      .set("Cookie", cookie)
      .send({ settings: { llm: { connection: "openai" }, rules: [{ ...rules[0], pattern: "b(?=c)" }] }, revision: await globalRevision() });
    expect(lookahead.status).toBe(400);
    expect(JSON.stringify(lookahead.body.errors.settings)).toMatch(/lookarounds/);

    const repo = await prisma.repository.create({
      data: { connectionId, provider: "gitlab", host: "gitlab.com", fullPath: "team/rules", externalId: "9", defaultBranch: "main" },
    });
    const own = [{ id: "no-c", description: "No c.", severity: "minor" }];
    const saved = await request(app).patch(`/api/repos/${repo.id}`).set("Cookie", cookie).send({ settings: { rules: own }, settingsRevision: await repoRevision(repo.id) });
    expect(saved.status).toBe(200);
    const duplicate = await request(app)
      .patch(`/api/repos/${repo.id}`)
      .set("Cookie", cookie)
      .send({ settings: { rules: [...own, ...own] }, settingsRevision: await repoRevision(repo.id) });
    expect(duplicate.status).toBe(400);
  });

  it("refuses repository rules the global rules would leave out, and warns when global rules grow", async () => {
    const many = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}`, description: "Rule.", severity: "minor" }));
    const global = await request(app)
      .put("/api/config/global")
      .set("Cookie", cookie)
      .send({ settings: { llm: { connection: "openai" }, rules: many("global", 45) }, revision: await globalRevision() });
    expect(global.status).toBe(200);

    const repo = await prisma.repository.create({
      data: { connectionId, provider: "gitlab", host: "gitlab.com", fullPath: "team/limits", externalId: "10", defaultBranch: "main", followGlobal: false },
    });
    const over = await request(app).patch(`/api/repos/${repo.id}`).set("Cookie", cookie).send({ settings: { rules: many("repo", 10) }, settingsRevision: await repoRevision(repo.id) });
    expect(over.status).toBe(400);
    expect(over.body.errors.rules[0]).toMatch(/^Rules in the repository settings were ignored: together with the rules below them, at most 50 rules/);

    const clash = await request(app).patch(`/api/repos/${repo.id}`).set("Cookie", cookie).send({ settings: { rules: many("global", 1) }, settingsRevision: await repoRevision(repo.id) });
    expect(clash.status).toBe(400);
    expect(clash.body.errors.rules).toEqual([
      "Rule global-0 in the repository settings was ignored: a rule with that id is already set in the global config",
    ]);

    // Following the global config, its own rules are not applied, so not checked.
    const following = await request(app)
      .patch(`/api/repos/${repo.id}`)
      .set("Cookie", cookie)
      .send({ settings: { rules: many("repo", 10) }, followGlobal: true, settingsRevision: await repoRevision(repo.id) });
    expect(following.status).toBe(200);
    await prisma.repository.update({ where: { id: repo.id }, data: { followGlobal: false } });

    const grown = await request(app)
      .put("/api/config/global")
      .set("Cookie", cookie)
      .send({ settings: { llm: { connection: "openai" }, rules: many("global", 45) }, revision: await globalRevision() });
    expect(grown.status).toBe(200);
    expect(grown.body.warnings).toEqual([expect.stringMatching(/^team\/limits: Rules in the repository settings were ignored/)]);
  });

  it("checks repository rules against the global settings as they are when the save commits", async () => {
    const rule = { id: "no-raw-sql", description: "Rule.", severity: "minor" };
    const repo = await prisma.repository.create({
      data: { connectionId, provider: "gitlab", host: "gitlab.com", fullPath: "team/race", externalId: "11", defaultBranch: "main", followGlobal: false },
    });
    const { workspaceId } = await prisma.forgeConnection.findUniqueOrThrow({ where: { id: connectionId } });
    // A global rule with the same id lands after the request loaded the
    // repository, just before its transaction starts.
    const original = prisma.$transaction.bind(prisma);
    const spy = vi.spyOn(prisma, "$transaction").mockImplementationOnce((async (...args: Parameters<typeof prisma.$transaction>) => {
      await prisma.workspace.update({ where: { id: workspaceId }, data: { reviewSettings: { rules: [rule] } } });
      return original(...args);
    }) as typeof prisma.$transaction);
    try {
      const res = await request(app)
        .patch(`/api/repos/${repo.id}`)
        .set("Cookie", cookie)
        .send({ settings: { rules: [rule] }, settingsRevision: await repoRevision(repo.id) });
      expect(res.status).toBe(400);
      expect(res.body.errors.rules).toEqual([
        "Rule no-raw-sql in the repository settings was ignored: a rule with that id is already set in the global config",
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it("checks the saved repository rules when a repository stops following the global settings", async () => {
    const rule = { id: "no-raw-sql", description: "Rule.", severity: "minor" };
    const repo = await prisma.repository.create({
      data: {
        connectionId,
        provider: "gitlab",
        host: "gitlab.com",
        fullPath: "team/switch",
        externalId: "12",
        defaultBranch: "main",
        followGlobal: true,
        settings: { rules: [rule] },
      },
    });
    const { workspaceId } = await prisma.forgeConnection.findUniqueOrThrow({ where: { id: connectionId } });
    await prisma.workspace.update({ where: { id: workspaceId }, data: { reviewSettings: { rules: [rule] } } });

    const res = await request(app).patch(`/api/repos/${repo.id}`).set("Cookie", cookie).send({ followGlobal: false });
    expect(res.status).toBe(400);
    expect(res.body.errors.rules).toEqual([
      "Rule no-raw-sql in the repository settings was ignored: a rule with that id is already set in the global config",
    ]);
    expect((await prisma.repository.findUniqueOrThrow({ where: { id: repo.id } })).followGlobal).toBe(true);

    // Following the global settings again never needs the check.
    const back = await request(app).patch(`/api/repos/${repo.id}`).set("Cookie", cookie).send({ followGlobal: true });
    expect(back.status).toBe(200);
  });

  it("checks a follow-global switch against the global settings as they are when it commits", async () => {
    const rule = { id: "no-raw-sql", description: "Rule.", severity: "minor" };
    const repo = await prisma.repository.create({
      data: {
        connectionId,
        provider: "gitlab",
        host: "gitlab.com",
        fullPath: "team/switch-race",
        externalId: "13",
        defaultBranch: "main",
        followGlobal: true,
        settings: { rules: [rule] },
      },
    });
    const { workspaceId } = await prisma.forgeConnection.findUniqueOrThrow({ where: { id: connectionId } });
    // A global rule with the same id lands after the request loaded the
    // repository, just before its transaction starts.
    const original = prisma.$transaction.bind(prisma);
    const spy = vi.spyOn(prisma, "$transaction").mockImplementationOnce((async (...args: Parameters<typeof prisma.$transaction>) => {
      await prisma.workspace.update({ where: { id: workspaceId }, data: { reviewSettings: { rules: [rule] } } });
      return original(...args);
    }) as typeof prisma.$transaction);
    try {
      const res = await request(app).patch(`/api/repos/${repo.id}`).set("Cookie", cookie).send({ followGlobal: false });
      expect(res.status).toBe(400);
      expect(res.body.errors.rules).toEqual([
        "Rule no-raw-sql in the repository settings was ignored: a rule with that id is already set in the global config",
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it("requires a saved connection for global configuration", async () => {
    const missing = await request(app)
      .put("/api/config/global")
      .set("Cookie", cookie)
      .send({ settings: { profile: "fast" }, revision: await globalRevision() });
    expect(missing.status).toBe(400);
    expect(missing.body.errors.connection).toEqual(["Select an LLM connection"]);

    const unsaved = await request(app)
      .put("/api/config/global")
      .set("Cookie", cookie)
      .send({ settings: { llm: { connection: "anthropic" } }, revision: await globalRevision() });
    expect(unsaved.status).toBe(400);
    expect(unsaved.body.errors.connection).toEqual([
      "Select a connection configured in Settings > API keys",
    ]);
  });

  it("keeps each user's global config separate", async () => {
    await request(app)
      .put("/api/config/global")
      .set("Cookie", cookie)
      .send({ settings: { profile: "fast", llm: { connection: "openai" } }, revision: await globalRevision() });
    const other = await createUser("other@example.com");

    const res = await request(app).get("/api/config/global").set("Cookie", other.cookie);

    expect(res.body.settings).toEqual({});
  });
});

describe("GET /api/config/schema", () => {
  it("returns defaults, profiles and enum choices", async () => {
    const res = await request(app).get("/api/config/schema").set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.defaults.review.blockOn).toBe("critical");
    expect(Object.keys(res.body.profiles)).toEqual(["balanced", "fast", "strict", "security"]);
    expect(res.body.severities).toEqual(["critical", "major", "minor", "info"]);
    // What the settings page resolves an "auto" context budget from.
    expect(res.body.contextWindows.anthropic).toBe(200_000);
    expect(res.body.defaultContextWindow).toBe(128_000);
    expect(res.body.thinkingBudgets).toEqual({ off: 0, low: 2_000, medium: 8_000, high: 24_000 });
  });
});

describe.each(["gitlab", "github"] as const)("%s webhook registration claims", (provider) => {
  function sentSecret(body: string): string {
    const hook = JSON.parse(body);
    return provider === "gitlab" ? hook.token : hook.config.secret;
  }

  function listedHook(id: number, url: string) {
    return provider === "gitlab" ? { id, url } : { id, config: { url } };
  }

  async function setup() {
    const original = await prisma.forgeConnection.findUniqueOrThrow({ where: { id: connectionId } });
    const connection = provider === "gitlab" ? original : await prisma.forgeConnection.create({
      data: {
        workspaceId: original.workspaceId,
        provider,
        host: "github.com",
        kind: "token",
        accountLogin: "dev",
        encryptedToken: encrypt("ghp"),
      },
    });
    const repo = await prisma.repository.create({
      data: {
        connectionId: connection.id,
        provider,
        host: connection.host,
        fullPath: "team/web",
        externalId: "1",
        defaultBranch: "main",
      },
    });
    return { repo, connection };
  }

  it("creates one hook when enable requests overlap and reuses it with stale repository data", async () => {
    const { repo, connection } = await setup();
    let signalStarted!: () => void;
    let releaseHook!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const released = new Promise<void>((resolve) => { releaseHook = resolve; });
    const stub = fetchStub([{ method: "POST", url: /\/hooks$/, body: { id: 314 } }]);
    vi.stubGlobal("fetch", async (...args: Parameters<typeof stub.fetch>) => {
      const response = await stub.fetch(...args);
      signalStarted();
      await released;
      return response;
    });

    const first = request(app).patch(`/api/repos/${repo.id}`).set("Cookie", cookie).send({ enabled: true }).then((res) => res);
    let pendingSecret: string | null;
    try {
      await started;
      const pending = await prisma.repository.findUniqueOrThrow({ where: { id: repo.id } });
      pendingSecret = pending.encryptedWebhookSecret;
      expect(pending.webhookId).toBeNull();
      expect(pendingSecret).not.toBeNull();

      const second = await request(app).patch(`/api/repos/${repo.id}`).set("Cookie", cookie).send({ enabled: true });
      expect(second.status).toBe(200);
      expect(second.body.repo.enabled).toBe(true);
      expect(second.body.webhook).toEqual({
        active: false,
        error: "Webhook registration is already in progress; try again shortly.",
      });
      expect(stub.calls).toHaveLength(1);
    } finally {
      releaseHook();
      await first;
    }

    expect((await first).body.webhook).toEqual({ active: true });
    const stored = await prisma.repository.findUniqueOrThrow({ where: { id: repo.id } });
    const hook = JSON.parse(stub.calls[0]!.body!);
    expect(stored.webhookId).toBe("314");
    expect(stored.encryptedWebhookSecret).toBe(pendingSecret!);
    expect(decrypt(stored.encryptedWebhookSecret!)).toBe(provider === "gitlab" ? hook.token : hook.config.secret);
    expect(await ensureWebhook(repo, connection)).toEqual({ active: true });
    expect(await ensureWebhook(stored, connection)).toEqual({ active: true });
    expect(stub.calls).toHaveLength(1);
  });

  it("keeps a refused registration claim so the next enable can reconcile and retry", async () => {
    const { repo } = await setup();
    const stub = fetchStub([
      { method: "POST", url: /\/hooks$/, status: 403, body: { message: "Forbidden" }, times: 1 },
      { url: /\/hooks\?per_page=100$/, body: [] },
      { method: "POST", url: /\/hooks$/, body: { id: 314 } },
    ]);
    vi.stubGlobal("fetch", stub.fetch);

    const failed = await request(app).patch(`/api/repos/${repo.id}`).set("Cookie", cookie).send({ enabled: true });
    expect(failed.status).toBe(200);
    expect(failed.body.webhook.active).toBe(false);
    expect(failed.body.webhook.error).toMatch(/Automatic reviews are off/);
    const pending = await prisma.repository.findUniqueOrThrow({ where: { id: repo.id } });
    expect(pending).toMatchObject({
      webhookId: null,
      enabled: true,
    });
    expect(pending.encryptedWebhookSecret).not.toBeNull();

    const retry = await request(app).patch(`/api/repos/${repo.id}`).set("Cookie", cookie).send({ enabled: true });
    expect(retry.status).toBe(200);
    expect(retry.body.webhook).toEqual({ active: true });
    expect(stub.calls.map((call) => call.method)).toEqual(["POST", "GET", "POST"]);
    const stored = await prisma.repository.findUniqueOrThrow({ where: { id: repo.id } });
    expect(stored.webhookId).toBe("314");
    expect(decrypt(stored.encryptedWebhookSecret!)).toBe(sentSecret(stub.calls[0]!.body!));
    expect(sentSecret(stub.calls[2]!.body!)).toBe(sentSecret(stub.calls[0]!.body!));
  });

  it("recovers an abandoned claim before creating the forge hook", async () => {
    const { repo, connection } = await setup();
    const claimedSecret = "claimed-secret";
    await prisma.repository.update({
      where: { id: repo.id },
      data: { encryptedWebhookSecret: encrypt(claimedSecret) },
    });
    const stub = fetchStub([
      { url: /\/hooks\?per_page=100$/, body: [] },
      { method: "POST", url: /\/hooks$/, body: { id: 314 } },
    ]);
    vi.stubGlobal("fetch", stub.fetch);

    expect(await ensureWebhook(repo, connection)).toEqual({ active: true });
    expect(stub.calls.map((call) => call.method)).toEqual(["GET", "POST"]);
    expect(sentSecret(stub.calls[1]!.body!)).toBe(claimedSecret);
    expect(await prisma.repository.findUniqueOrThrow({ where: { id: repo.id } })).toMatchObject({ webhookId: "314" });
  });

  it("does not clear a claim replaced while forge creation was failing", async () => {
    const { repo, connection } = await setup();
    const replacement = encrypt("replacement-secret");
    const stub = fetchStub([{ method: "POST", url: /\/hooks$/, status: 403, body: { message: "Forbidden" } }]);
    vi.stubGlobal("fetch", async (...args: Parameters<typeof stub.fetch>) => {
      await prisma.repository.update({ where: { id: repo.id }, data: { encryptedWebhookSecret: replacement } });
      return stub.fetch(...args);
    });

    expect((await ensureWebhook(repo, connection)).active).toBe(false);
    const stored = await prisma.repository.findUniqueOrThrow({ where: { id: repo.id } });
    expect(stored.encryptedWebhookSecret).toBe(replacement);
  });

  it("reconciles the created hook after saving its id fails", async () => {
    const { repo, connection } = await setup();
    const url = webhookUrl(provider, repo.id);
    const stub = fetchStub([
      { method: "POST", url: /\/hooks$/, body: { id: 314 } },
      { url: /\/hooks\?per_page=100$/, body: [listedHook(314, url)] },
    ]);
    vi.stubGlobal("fetch", stub.fetch);
    const updateMany = prisma.repository.updateMany.bind(prisma.repository);
    const save = vi.spyOn(prisma.repository, "updateMany")
      .mockImplementationOnce((args) => updateMany(args))
      .mockRejectedValueOnce(new Error("Database unavailable"));
    try {
      await expect(ensureWebhook(repo, connection)).rejects.toThrow("Database unavailable");
    } finally {
      save.mockRestore();
    }

    const stored = await prisma.repository.findUniqueOrThrow({ where: { id: repo.id } });
    const hook = JSON.parse(stub.calls[0]!.body!);
    expect(stored.webhookId).toBeNull();
    expect(decrypt(stored.encryptedWebhookSecret!)).toBe(provider === "gitlab" ? hook.token : hook.config.secret);
    expect(await ensureWebhook(repo, connection)).toEqual({ active: true });
    expect(stub.calls.map((call) => call.method)).toEqual(["POST", "GET"]);
    expect(await prisma.repository.findUniqueOrThrow({ where: { id: repo.id } })).toMatchObject({ webhookId: "314" });
  });
});

describe("GitLab webhooks follow the enabled switch", () => {
  it("registers a hook with a stored secret when enabling, and removes it when disabling", async () => {
    const { fetch, calls } = fetchStub([
      { url: /\/api\/v4\/projects\/1$/, body: project(1, "team/web") },
      { method: "POST", url: /\/api\/v4\/projects\/1\/hooks$/, body: { id: 314 } },
      { method: "DELETE", url: /\/api\/v4\/projects\/1\/hooks\/314$/, status: 204, body: "" },
    ]);
    vi.stubGlobal("fetch", fetch);

    const enabled = await request(app).post("/api/repos").set("Cookie", cookie).send({ connectionId, externalId: "1" });

    expect(enabled.body.webhook).toEqual({ active: true });
    const hookCall = calls.find((c) => c.method === "POST")!;
    const hook = JSON.parse(hookCall.body!);
    expect(hook).toMatchObject({
      url: `https://sentryward.example.com/api/webhooks/gitlab/${enabled.body.repo.id}`,
      merge_requests_events: true,
      note_events: true,
      push_events: false,
    });
    const stored = await prisma.repository.findUniqueOrThrow({ where: { id: enabled.body.repo.id } });
    expect(stored.webhookId).toBe("314");
    expect(stored.encryptedWebhookSecret).not.toContain(hook.token);
    expect(enabled.body.repo.encryptedWebhookSecret).toBeUndefined();

    await request(app).patch(`/api/repos/${enabled.body.repo.id}`).set("Cookie", cookie).send({ enabled: false });

    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
    expect(await prisma.repository.findUniqueOrThrow({ where: { id: enabled.body.repo.id } })).toMatchObject({
      webhookId: null,
      encryptedWebhookSecret: null,
    });
  });

  it("keeps the repository enabled and explains when GitLab refuses the hook", async () => {
    vi.stubGlobal(
      "fetch",
      fetchStub([
        { url: /\/api\/v4\/projects\/1$/, body: project(1, "team/web") },
        { method: "POST", url: /\/hooks$/, status: 403, body: { message: "403 Forbidden" } },
      ]).fetch,
    );

    const res = await request(app).post("/api/repos").set("Cookie", cookie).send({ connectionId, externalId: "1" });

    expect(res.status).toBe(201);
    expect(res.body.repo.enabled).toBe(true);
    expect(res.body.webhook.active).toBe(false);
    expect(res.body.webhook.error).toMatch(/Automatic reviews are off/);
  });
});

describe("GitHub token connections get their own repository hook", () => {
  it("registers a signed hook when enabling and removes it when disabling", async () => {
    const connection = await prisma.forgeConnection.create({
      data: {
        workspaceId: (await prisma.forgeConnection.findUniqueOrThrow({ where: { id: connectionId } })).workspaceId,
        provider: "github",
        host: "ghe.acme.com",
        kind: "token",
        accountLogin: "dev",
        encryptedToken: encrypt("ghp"),
      },
    });
    const { fetch, calls } = fetchStub([
      {
        url: /ghe\.acme\.com\/api\/v3\/repositories\/5$/,
        body: { id: 5, full_name: "acme/api", default_branch: "main", private: true, html_url: "u" },
      },
      { method: "POST", url: /\/repos\/acme\/api\/hooks$/, body: { id: 616 } },
      { method: "DELETE", url: /\/repos\/acme\/api\/hooks\/616$/, status: 204, body: "" },
    ]);
    vi.stubGlobal("fetch", fetch);

    const enabled = await request(app)
      .post("/api/repos")
      .set("Cookie", cookie)
      .send({ connectionId: connection.id, externalId: "5" });

    expect(enabled.body.webhook).toEqual({ active: true });
    const hook = JSON.parse(calls.find((c) => c.method === "POST")!.body!);
    expect(hook.config.url).toBe(`https://sentryward.example.com/api/webhooks/github/${enabled.body.repo.id}`);
    const stored = await prisma.repository.findUniqueOrThrow({ where: { id: enabled.body.repo.id } });
    expect(stored.webhookId).toBe("616");
    expect(decrypt(stored.encryptedWebhookSecret!)).toBe(hook.config.secret);

    await request(app).patch(`/api/repos/${enabled.body.repo.id}`).set("Cookie", cookie).send({ enabled: false });

    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
    expect((await prisma.repository.findUniqueOrThrow({ where: { id: enabled.body.repo.id } })).webhookId).toBeNull();
  });
});

describe("folder settings", () => {
  async function monorepo() {
    return prisma.repository.create({
      data: { connectionId, provider: "gitlab", host: "gitlab.com", fullPath: "team/mono", externalId: "20", defaultBranch: "main", followGlobal: false },
    });
  }

  const folders = (id: string) => `/api/repos/${id}/directories`;

  it("adds, saves and removes one folder at a time, normalising the path", async () => {
    const repo = await monorepo();

    const added = await request(app).post(folders(repo.id)).set("Cookie", cookie).send({ path: "./services/billing/" });
    expect(added.status).toBe(201);
    expect(added.body.repo.directories).toEqual([{ path: "services/billing", settings: {} }]);

    const saved = await request(app)
      .put(folders(repo.id))
      .set("Cookie", cookie)
      .send({ path: "services/billing", settings: { profile: "strict" } });
    expect(saved.status).toBe(200);
    expect(saved.body.repo.directories).toEqual([{ path: "services/billing", settings: { profile: "strict" } }]);

    const removed = await request(app).delete(`${folders(repo.id)}?path=services%2Fbilling`).set("Cookie", cookie);
    expect(removed.status).toBe(200);
    expect(removed.body.repo.directories).toEqual([]);
  });

  it("keeps folders added by someone else since the page loaded", async () => {
    const repo = await monorepo();
    // Two admins (or tabs) each add a folder from the same stale page: each
    // request names only its own folder, so neither drops the other.
    await request(app).post(folders(repo.id)).set("Cookie", cookie).send({ path: "web" });
    await request(app).post(folders(repo.id)).set("Cookie", cookie).send({ path: "api" });
    const saved = await request(app).put(folders(repo.id)).set("Cookie", cookie).send({ path: "web", settings: { profile: "strict" } });

    expect(saved.body.repo.directories).toEqual([
      { path: "web", settings: { profile: "strict" } },
      { path: "api", settings: {} },
    ]);
  });

  it("refuses nested and duplicate folders, and changes to folders not saved", async () => {
    const repo = await monorepo();
    await request(app).post(folders(repo.id)).set("Cookie", cookie).send({ path: "services" });

    const nested = await request(app).post(folders(repo.id)).set("Cookie", cookie).send({ path: "services/billing" });
    expect(nested.status).toBe(400);
    expect(nested.body.errors.directories).toEqual(["services/billing overlaps services; folders cannot be inside one another"]);
    const dup = await request(app).post(folders(repo.id)).set("Cookie", cookie).send({ path: "services/" });
    expect(dup.body.errors.directories).toEqual(["services is already configured"]);

    const missing = await request(app).put(folders(repo.id)).set("Cookie", cookie).send({ path: "web", settings: {} });
    expect(missing.status).toBe(404);
    expect((await request(app).delete(`${folders(repo.id)}?path=web`).set("Cookie", cookie)).status).toBe(404);
    expect((await request(app).post(folders(repo.id)).set("Cookie", cookie).send({ path: "web/*" })).status).toBe(400);
  });

  it("refuses folder rules that clash, and unknown connections", async () => {
    const repo = await monorepo();
    await request(app).post(folders(repo.id)).set("Cookie", cookie).send({ path: "web" });
    await request(app).patch(`/api/repos/${repo.id}`).set("Cookie", cookie).send({ settings: { rules: [{ id: "own", description: "Own.", severity: "minor" }] }, settingsRevision: await repoRevision(repo.id) });

    const clash = await request(app)
      .put(folders(repo.id))
      .set("Cookie", cookie)
      .send({ path: "web", settings: { rules: [{ id: "own", description: "Weaker.", severity: "info" }] } });
    expect(clash.status).toBe(400);
    expect(clash.body.errors.rules).toEqual([
      "web: Rule own in the folder settings was ignored: a rule with that id is already set in the repository settings",
    ]);

    // Only openai is stored for this workspace.
    const connection = await request(app).put(folders(repo.id)).set("Cookie", cookie).send({ path: "web", settings: { llm: { connection: "anthropic" } } });
    expect(connection.status).toBe(400);
    expect(connection.body.errors.connection).toBeDefined();
  });

  it("refuses repository rules that would push out a folder's rules, but not because of a folder already broken", async () => {
    const repo = await monorepo();
    await request(app).post(folders(repo.id)).set("Cookie", cookie).send({ path: "web" });
    await request(app)
      .put(folders(repo.id))
      .set("Cookie", cookie)
      .send({ path: "web", settings: { rules: [{ id: "web-rule", description: "Web.", severity: "minor" }] } });

    const clash = await request(app)
      .patch(`/api/repos/${repo.id}`)
      .set("Cookie", cookie)
      .send({ settings: { rules: [{ id: "web-rule", description: "Repo.", severity: "info" }] }, settingsRevision: await repoRevision(repo.id) });
    expect(clash.status).toBe(400);
    expect(clash.body.errors.rules).toEqual([
      "web: Rule web-rule in the folder settings was ignored: a rule with that id is already set in the repository settings",
    ]);
    expect((await prisma.repository.findUniqueOrThrow({ where: { id: repo.id } })).settings).toEqual({});

    // Once the folder is broken anyway (saved directly, as if from before this
    // check), other repository edits still save.
    await prisma.repository.update({
      where: { id: repo.id },
      data: { settings: { rules: [{ id: "web-rule", description: "Repo.", severity: "info" }] } },
    });
    const unrelated = await request(app)
      .patch(`/api/repos/${repo.id}`)
      .set("Cookie", cookie)
      .send({ settings: { rules: [{ id: "web-rule", description: "Repo.", severity: "info" }, { id: "other", description: "Other.", severity: "minor" }] }, settingsRevision: await repoRevision(repo.id) });
    expect(unrelated.status).toBe(200);
  });

  it("checks only the folder being saved, so a stale one does not block the rest", async () => {
    const repo = await monorepo();
    // Valid when saved; since then its connection was removed and the
    // repository settings gained a rule with the same id.
    await prisma.repository.update({
      where: { id: repo.id },
      data: {
        settings: { rules: [{ id: "own", description: "Own.", severity: "minor" }] },
        directories: [
          { path: "old", settings: { llm: { connection: "anthropic" }, rules: [{ id: "own", description: "Old.", severity: "info" }] } },
        ],
      },
    });

    const added = await request(app).post(folders(repo.id)).set("Cookie", cookie).send({ path: "web" });
    expect(added.status).toBe(201);
    const saved = await request(app)
      .put(folders(repo.id))
      .set("Cookie", cookie)
      .send({ path: "web", settings: { rules: [{ id: "web-rule", description: "Web.", severity: "minor" }] } });
    expect(saved.status).toBe(200);
  });

  it("lets only admins change folders", async () => {
    const owner = await createUser("owner@example.com");
    const team = await createTeam(owner.user.id, "Acme");
    const me = await prisma.user.findUniqueOrThrow({ where: { email: "dev@example.com" } });
    await addMember(team.id, me.id, "member");
    const teamConnection = await prisma.forgeConnection.create({
      data: { workspaceId: team.id, provider: "gitlab", host: "gitlab.com", kind: "token", accountLogin: "acme" },
    });
    const repo = await prisma.repository.create({
      data: { connectionId: teamConnection.id, provider: "gitlab", host: "gitlab.com", fullPath: "acme/mono", externalId: "30", defaultBranch: "main" },
    });

    const res = await request(app).post(folders(repo.id)).set("Cookie", cookie).set(...inWorkspace(team.id)).send({ path: "web" });
    expect(res.status).toBe(403);
  });

  it("no longer takes folders through PATCH", async () => {
    const repo = await monorepo();
    const res = await request(app).patch(`/api/repos/${repo.id}`).set("Cookie", cookie).send({ directories: [] });
    expect(res.status).toBe(400);
  });

  it("shows a folder's effective config, and 404s for one not saved", async () => {
    const repo = await monorepo();
    await prisma.repository.update({
      where: { id: repo.id },
      data: { settings: { review: { maxFindings: 10 } }, directories: [{ path: "web", settings: { review: { minConfidence: 0.8 } } }] },
    });
    vi.stubGlobal("fetch", fetchStub([{ url: /\/repository\/files\//, status: 404, body: "" }]).fetch);

    const res = await request(app).get(`/api/repos/${repo.id}/config?directory=web`).set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.directory).toBe("web");
    expect(res.body.config.review).toMatchObject({ maxFindings: 10, minConfidence: 0.8 });
    expect(res.body.sources["review.minConfidence"]).toBe("directory");

    const repoOnly = await request(app).get(`/api/repos/${repo.id}/config`).set("Cookie", cookie);
    expect(repoOnly.body.directory).toBeNull();

    const missing = await request(app).get(`/api/repos/${repo.id}/config?directory=api`).set("Cookie", cookie);
    expect(missing.status).toBe(404);

    // Also while following the global config, which only makes a saved folder
    // inactive.
    await prisma.repository.update({ where: { id: repo.id }, data: { followGlobal: true } });
    expect((await request(app).get(`/api/repos/${repo.id}/config?directory=api`).set("Cookie", cookie)).status).toBe(404);
    const inactive = await request(app).get(`/api/repos/${repo.id}/config?directory=web`).set("Cookie", cookie);
    expect(inactive.status).toBe(200);
    expect(inactive.body.directory).toBeNull();
  });

  it("returns what a folder inherits, without the repository file", async () => {
    const repo = await monorepo();
    await prisma.repository.update({
      where: { id: repo.id },
      data: {
        settings: { review: { maxFindings: 10 }, rules: [{ id: "repo-rule", description: "Repo.", severity: "minor" }] },
        directories: [{ path: "web", settings: {} }],
      },
    });
    vi.stubGlobal(
      "fetch",
      fetchStub([
        {
          url: /\/repository\/files\/\.sentryward\.yaml\/raw\?ref=main$/,
          body: "review:\n  max_findings: 3\nrules:\n  - id: file-rule\n    description: File.\n    severity: major\n",
        },
      ]).fetch,
    );

    const res = await request(app).get(`/api/repos/${repo.id}/config?directory=web`).set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.config.review.maxFindings).toBe(3);
    expect(res.body.inherited.config.review.maxFindings).toBe(10);
    expect(res.body.inherited.sources["review.maxFindings"]).toBe("repoSettings");
    expect(res.body.inherited.config.rules.map((rule: { id: string }) => rule.id)).toEqual(["repo-rule"]);

    const repoOnly = await request(app).get(`/api/repos/${repo.id}/config`).set("Cookie", cookie);
    expect(repoOnly.body.inherited).toBeUndefined();
  });
});
