import type { Request, Response } from "express";
import { audit } from "./audit";
import { db } from "./db";

export async function renameProject(req: Request, res: Response) {
  const project = await db.project.update({
    where: { id: req.params.id, ownerId: req.userId },
    data: { name: String(req.body.name) },
  });
  await audit(req.userId, "project.rename", project.id);
  res.json({ project });
}

export async function archiveProject(req: Request, res: Response) {
  const project = await db.project.update({
    where: { id: req.params.id, ownerId: req.userId },
    data: { archivedAt: new Date() },
  });
  res.json({ project });
}
