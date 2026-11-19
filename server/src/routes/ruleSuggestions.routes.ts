import { Router } from "express";
import {
  approveRuleSuggestion,
  discardRuleSuggestion,
  getRuleSuggestionSettings,
  listRuleSuggestions,
  runRuleSuggestions,
  saveRuleSuggestionSettings,
} from "../controllers/ruleSuggestions.controller.ts";
import { userLimiter } from "../middleware/apiLimiter.ts";
import { requireAuth } from "../middleware/requireAuth.ts";
import { requireWorkspace, requireWorkspaceRole } from "../middleware/requireWorkspace.ts";

export const ruleSuggestionsRouter = Router();

// Admins only: suggestions quote review comments from every repository, and
// approving one changes review settings.
ruleSuggestionsRouter.use(userLimiter, requireAuth, requireWorkspace, requireWorkspaceRole("admin"));
ruleSuggestionsRouter.get("/", listRuleSuggestions);
// Before "/:id/...", so "settings" and "run" are never read as ids.
ruleSuggestionsRouter.get("/settings", getRuleSuggestionSettings);
ruleSuggestionsRouter.put("/settings", saveRuleSuggestionSettings);
ruleSuggestionsRouter.post("/run", runRuleSuggestions);
ruleSuggestionsRouter.post("/:id/approve", approveRuleSuggestion);
ruleSuggestionsRouter.post("/:id/discard", discardRuleSuggestion);
