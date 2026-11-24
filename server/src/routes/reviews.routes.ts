import { Router } from "express";
import {
  cancelReview,
  createReview,
  createTrial,
  getReview,
  getReviewAttention,
  getReviewChange,
  getReviewDiff,
  getReviewMarkdown,
  getReviewStats,
  listReviews,
  markReviewsViewed,
  rerunReview,
} from "../controllers/reviews.controller.ts";
import { requireAuth } from "../middleware/requireAuth.ts";
import { requireWorkspace, requireWorkspaceRole } from "../middleware/requireWorkspace.ts";
import { userLimiter } from "../middleware/apiLimiter.ts";

export const reviewsRouter = Router();

reviewsRouter.use(userLimiter, requireAuth, requireWorkspace);
reviewsRouter.get("/", listReviews);
reviewsRouter.post("/", createReview);
// Before "/:id", which would reject these as malformed ids.
// A trial runs a reviewer nobody saved, so only those who may save one start it.
reviewsRouter.post("/trial", requireWorkspaceRole("admin"), createTrial);
reviewsRouter.get("/stats", getReviewStats);
reviewsRouter.get("/attention", getReviewAttention);
reviewsRouter.post("/viewed", markReviewsViewed);
reviewsRouter.get("/:id", getReview);
reviewsRouter.get("/:id/markdown", getReviewMarkdown);
reviewsRouter.get("/:id/diff", getReviewDiff);
reviewsRouter.get("/:id/change", getReviewChange);
reviewsRouter.post("/:id/rerun", rerunReview);
reviewsRouter.post("/:id/cancel", cancelReview);
