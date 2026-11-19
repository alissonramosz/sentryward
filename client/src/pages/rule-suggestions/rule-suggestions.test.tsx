import { describe, expect, it, vi } from "vitest"
import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { App } from "@/App"
import { jsonResponse, renderWithProviders } from "@/test/renderWithProviders"
import { mockApi } from "@/test/apiRoutes"
import type { RuleSuggestion, SuggestionSettings } from "@/features/rule-suggestions/api"

const settings: SuggestionSettings = {
  enabled: true,
  minEvidence: 5,
  excludedReviewers: [],
  lastRunAt: "2026-11-10T12:00:00Z",
  storedComments: 12,
}

const suggestion: RuleSuggestion = {
  id: "s-1",
  status: "pending",
  rule: { id: "db-in-repos", description: "Keep database calls in the repository layer.", severity: "minor", paths: ["src/billing/**"] },
  rationale: "Reviewers asked for it on several changes.",
  evidence: {
    findingIds: [],
    commentIds: ["c1", "c2"],
    changes: 2,
    excerpts: [{ kind: "comment", repository: "github.com/acme/web", number: 4, file: "src/billing/api.ts", text: "Move this query out" }],
  },
  model: "anthropic/claude-sonnet-5-5",
  appliedTarget: null,
  decidedAt: null,
  createdAt: "2026-11-12T12:00:00Z",
  repository: null,
}

const list = (suggestions: RuleSuggestion[]) => ({ suggestions, counts: { pending: suggestions.length, approved: 0, discarded: 0 } })
const PENDING = "GET /api/rule-suggestions?status=pending"
const base = {
  "GET /api/rule-suggestions/counts": { counts: { pending: 0, approved: 0, discarded: 0 } },
  "GET /api/rule-suggestions/settings": settings,
  "GET /api/repos": { repos: [] },
  "GET /api/config/schema": { severities: ["critical", "major", "minor", "info"], categories: ["bug", "maintainability"] },
}

describe("Rule suggestions page", () => {
  it("lists pending suggestions with their evidence", async () => {
    mockApi({ ...base, [PENDING]: list([suggestion]) })
    renderWithProviders(<App />, { route: "/rule-suggestions" })

    expect(await screen.findByText("db-in-repos")).toBeInTheDocument()
    expect(screen.getByText("Suggested for Global settings", { exact: false })).toBeInTheDocument()
    expect(screen.getByText("Why this rule")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Pending \(1\)/ })).toBeInTheDocument()

    // Excerpts stay folded under the summary until asked for.
    expect(screen.queryByText("Move this query out")).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Based on 2 comments across 2 changes" }))
    expect(screen.getByText("Move this query out")).toBeInTheDocument()
  })

  it("leads with the list and keeps settings folded while the feature is on", async () => {
    mockApi({ ...base, [PENDING]: list([suggestion]) })
    renderWithProviders(<App />, { route: "/rule-suggestions" })

    await screen.findByText("db-in-repos")
    expect(screen.getByText(/12 review comments stored/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Settings" })).toHaveAttribute("aria-expanded", "false")
    expect(screen.getByLabelText("Minimum evidence")).not.toBeVisible()
  })

  it("says the feature is off instead of showing an empty list", async () => {
    mockApi({ ...base, "GET /api/rule-suggestions/settings": { ...settings, enabled: false, lastRunAt: null }, [PENDING]: list([]) })
    renderWithProviders(<App />, { route: "/rule-suggestions" })

    expect(await screen.findByText("Rule suggestions are off")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Settings" })).toHaveAttribute("aria-expanded", "true")
    expect(screen.queryByRole("button", { name: "Check now" })).not.toBeInTheDocument()
  })

  it("starts a check from the settings header", async () => {
    const run = vi.fn(() => jsonResponse(200, { ...settings, lastRunAt: null }))
    mockApi({ ...base, [PENDING]: list([]), "POST /api/rule-suggestions/run": run })
    renderWithProviders(<App />, { route: "/rule-suggestions" })

    await userEvent.click(await screen.findByRole("button", { name: "Check now" }))
    await waitFor(() => expect(run).toHaveBeenCalled())
  })

  it("offers the global settings when the chosen repository follows them", async () => {
    const repo = { id: "r-1", fullPath: "acme/web", followGlobal: true }
    mockApi({ ...base, "GET /api/repos": { repos: [repo] }, [PENDING]: list([{ ...suggestion, repository: { ...repo, host: "github.com" } }]) })
    renderWithProviders(<App />, { route: "/rule-suggestions" })

    await userEvent.click(await screen.findByRole("button", { name: "Approve…" }))
    const dialog = await screen.findByRole("dialog", { name: "Approve rule" })
    expect(within(dialog).getByRole("button", { name: "Approve" })).toBeDisabled()
    await userEvent.click(within(dialog).getByRole("button", { name: "Add to global settings instead" }))
    expect(within(dialog).getByRole("button", { name: "Approve" })).toBeEnabled()
    expect(within(dialog).getByText(/Applies to every repository/)).toBeInTheDocument()
  })

  it("approves an edited rule into the global settings", async () => {
    const approve = vi.fn(() => jsonResponse(200, { suggestion: { ...suggestion, status: "approved" } }))
    mockApi({ ...base, [PENDING]: list([suggestion]), "POST /api/rule-suggestions/s-1/approve": approve })
    renderWithProviders(<App />, { route: "/rule-suggestions" })

    await userEvent.click(await screen.findByRole("button", { name: "Approve…" }))
    const dialog = await screen.findByRole("dialog", { name: "Approve rule" })
    const id = within(dialog).getByLabelText("Id")
    await userEvent.clear(id)
    await userEvent.type(id, "no-db-in-handlers")
    await userEvent.click(within(dialog).getByRole("button", { name: "Approve" }))

    await waitFor(() => expect(approve).toHaveBeenCalled())
    const [init] = approve.mock.calls[0] as unknown as [RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({
      rule: { id: "no-db-in-handlers", description: "Keep database calls in the repository layer.", severity: "minor", paths: ["src/billing/**"] },
      target: "global",
    })
  })

  it("shows the server's reason a rule cannot be added", async () => {
    mockApi({
      ...base,
      [PENDING]: list([suggestion]),
      "POST /api/rule-suggestions/s-1/approve": () =>
        jsonResponse(400, { message: "Validation failed", errors: { "rule.id": ["A rule named db-in-repos already exists there"] } }),
    })
    renderWithProviders(<App />, { route: "/rule-suggestions" })

    await userEvent.click(await screen.findByRole("button", { name: "Approve…" }))
    const dialog = await screen.findByRole("dialog", { name: "Approve rule" })
    await userEvent.click(within(dialog).getByRole("button", { name: "Approve" }))
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("already exists")
  })

  it("discards a suggestion", async () => {
    const discard = vi.fn(() => jsonResponse(200, { suggestion: { ...suggestion, status: "discarded" } }))
    mockApi({ ...base, [PENDING]: list([suggestion]), "POST /api/rule-suggestions/s-1/discard": discard })
    renderWithProviders(<App />, { route: "/rule-suggestions" })

    await userEvent.click(await screen.findByRole("button", { name: "Discard" }))
    const dialog = await screen.findByRole("dialog", { name: "Discard suggestion?" })
    expect(discard).not.toHaveBeenCalled()
    await userEvent.click(within(dialog).getByRole("button", { name: "Discard" }))
    await waitFor(() => expect(discard).toHaveBeenCalled())
  })

  it("saves settings", async () => {
    const save = vi.fn(() => jsonResponse(200, { ...settings, minEvidence: 3 }))
    mockApi({ ...base, [PENDING]: list([]), "PUT /api/rule-suggestions/settings": save })
    renderWithProviders(<App />, { route: "/rule-suggestions" })

    await userEvent.click(await screen.findByRole("button", { name: "Settings" }))
    const min = screen.getByLabelText("Minimum evidence")
    await userEvent.clear(min)
    await userEvent.type(min, "3")
    await userEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(save).toHaveBeenCalled())
    const [init] = save.mock.calls[0] as unknown as [RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ enabled: true, minEvidence: 3, excludedReviewers: [] })
    expect(screen.getByText(/Nothing to review/)).toBeInTheDocument()
  })
})
