import { describe, expect, it } from "vitest"
import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { App } from "@/App"
import { jsonResponse, renderWithProviders } from "@/test/renderWithProviders"
import { mockApi, testUser, testWorkspaces } from "@/test/apiRoutes"
import type { Budget } from "./api"

const noKeys = { keys: [] }
const prices = { prices: [], models: [] }

const NO_BUDGET: Budget = {
  monthlyBudgetUsd: null,
  month: "2026-11",
  spendUsd: 3.2,
  percent: null,
  unpricedCalls: 0,
  unpricedModels: [],
  alertsSent: [],
  budgetTargets: 0,
  adminEmail: true,
}

const WITH_BUDGET: Budget = {
  ...NO_BUDGET,
  monthlyBudgetUsd: 10,
  spendUsd: 9.4,
  percent: 94,
  alertsSent: [
    { threshold: 50, at: "2026-11-10T00:00:00.000Z" },
    { threshold: 75, at: "2026-11-14T00:00:00.000Z" },
    { threshold: 90, at: "2026-11-17T00:00:00.000Z" },
  ],
  budgetTargets: 1,
}

const budgetCard = async () => (await screen.findByText("Monthly budget")).closest("[data-slot=card]") as HTMLElement

describe("Monthly budget", () => {
  it("sets a budget", async () => {
    const saved: unknown[] = []
    mockApi({
      "GET /api/settings/api-keys": noKeys,
      "GET /api/settings/model-prices": prices,
      "GET /api/settings/budget": NO_BUDGET,
      "PUT /api/settings/budget": (init?: RequestInit) => {
        saved.push(JSON.parse(String(init?.body)))
        return jsonResponse(200, { ...WITH_BUDGET, monthlyBudgetUsd: 25, percent: 37 })
      },
    })
    renderWithProviders(<App />, { route: "/llm-connections?tab=prices" })

    const card = await budgetCard()
    expect(await within(card).findByText(/No budget set/)).toBeInTheDocument()
    await userEvent.click(within(card).getByRole("button", { name: "Set budget" }))
    const dialog = await screen.findByRole("dialog")
    await userEvent.type(within(dialog).getByLabelText("Budget (USD)"), "25")
    await userEvent.click(within(dialog).getByRole("button", { name: "Save budget" }))

    await waitFor(() => expect(saved).toEqual([{ monthlyBudgetUsd: 25 }]))
    expect(await within(card).findByRole("meter", { name: "Spend this month" })).toHaveAttribute("aria-valuenow", "37")
  })

  it("shows the server's reason a budget cannot be switched on", async () => {
    const message = "Set a price for openai/my-proxy under Model prices first"
    mockApi({
      "GET /api/settings/api-keys": noKeys,
      "GET /api/settings/model-prices": prices,
      "GET /api/settings/budget": { ...NO_BUDGET, unpricedModels: ["openai/my-proxy"] },
      "PUT /api/settings/budget": () => jsonResponse(400, { message, errors: { monthlyBudgetUsd: [message] } }),
    })
    renderWithProviders(<App />, { route: "/llm-connections?tab=prices" })

    const card = await budgetCard()
    expect(await within(card).findByText("1 model used recently has no price")).toBeInTheDocument()
    await userEvent.click(within(card).getByRole("button", { name: "Set budget" }))
    const dialog = await screen.findByRole("dialog")
    await userEvent.type(within(dialog).getByLabelText("Budget (USD)"), "10")
    await userEvent.click(within(dialog).getByRole("button", { name: "Save budget" }))
    expect(await within(dialog).findByText(message)).toBeInTheDocument()
  })

  it("refuses an amount that is not above 0 before saving", async () => {
    mockApi({
      "GET /api/settings/api-keys": noKeys,
      "GET /api/settings/model-prices": prices,
      "GET /api/settings/budget": NO_BUDGET,
    })
    renderWithProviders(<App />, { route: "/llm-connections?tab=prices" })

    await userEvent.click(await within(await budgetCard()).findByRole("button", { name: "Set budget" }))
    const dialog = await screen.findByRole("dialog")
    await userEvent.type(within(dialog).getByLabelText("Budget (USD)"), "0")
    await userEvent.click(within(dialog).getByRole("button", { name: "Save budget" }))
    expect(await within(dialog).findByText("Enter an amount above 0")).toBeInTheDocument()
  })

  it("shows the month's spend, the alerts sent and a missing target", async () => {
    mockApi({
      "GET /api/settings/api-keys": noKeys,
      "GET /api/settings/model-prices": prices,
      "GET /api/settings/budget": { ...WITH_BUDGET, budgetTargets: 0, unpricedCalls: 3 },
    })
    renderWithProviders(<App />, { route: "/llm-connections?tab=prices" })

    const card = await budgetCard()
    expect(await within(card).findByRole("meter", { name: "Spend this month" })).toHaveAttribute("aria-valuenow", "94")
    expect(within(card).getByText("94%")).toBeInTheDocument()
    expect(within(card).getByText("90%")).toBeInTheDocument()
    expect(within(card).getByText("3 model calls this month had no price and are not counted.")).toBeInTheDocument()
    expect(within(card).getByText("No notification target listens for budget alerts")).toBeInTheDocument()
    expect(within(card).getByRole("link", { name: "Add the Budget event to a target" })).toHaveAttribute("href", "/notifications")
  })

  it("removes the budget", async () => {
    const saved: unknown[] = []
    mockApi({
      "GET /api/settings/api-keys": noKeys,
      "GET /api/settings/model-prices": prices,
      "GET /api/settings/budget": WITH_BUDGET,
      "PUT /api/settings/budget": (init?: RequestInit) => {
        saved.push(JSON.parse(String(init?.body)))
        return jsonResponse(200, NO_BUDGET)
      },
    })
    renderWithProviders(<App />, { route: "/llm-connections?tab=prices" })

    await userEvent.click(await within(await budgetCard()).findByRole("button", { name: "Edit budget" }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByLabelText("Budget (USD)")).toHaveValue("10")
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove budget" }))
    await waitFor(() => expect(saved).toEqual([{ monthlyBudgetUsd: null }]))
  })

  it("shows members the budget without letting them change it", async () => {
    const asMember = testWorkspaces.map((workspace) => ({ ...workspace, role: "member" }))
    mockApi({
      "GET /api/auth/me": { user: testUser, workspaces: asMember },
      "GET /api/workspaces": { workspaces: asMember },
      "GET /api/settings/api-keys": noKeys,
      "GET /api/settings/model-prices": prices,
      "GET /api/settings/budget": WITH_BUDGET,
    })
    renderWithProviders(<App />, { route: "/llm-connections?tab=prices" })

    const card = await budgetCard()
    expect(await within(card).findByRole("meter", { name: "Spend this month" })).toBeInTheDocument()
    expect(within(card).queryByRole("button", { name: "Edit budget" })).not.toBeInTheDocument()
  })
})
