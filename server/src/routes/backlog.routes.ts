import { Router } from "express";
import { getBacklogItem, getBacklogStats, listBacklog, updateBacklogItem } from "../controllers/backlog.controller.ts";
import { requireAuth } from "../middleware/requireAuth.ts";
import { requireWorkspace } from "../middleware/requireWorkspace.ts";
import { userLimiter } from "../middleware/apiLimiter.ts";

export const backlogRouter = Router();

backlogRouter.use(userLimiter, requireAuth, requireWorkspace);
backlogRouter.get("/", listBacklog);
// Before "/:id", which would reject "stats" as a malformed id.
backlogRouter.get("/stats", getBacklogStats);
backlogRouter.get("/:id", getBacklogItem);
backlogRouter.patch("/:id", updateBacklogItem);
