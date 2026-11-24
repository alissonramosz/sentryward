import { db } from "./db";

// Every write a user makes is recorded, so support can answer "who changed this".
export async function audit(userId: string, action: string, target: string): Promise<void> {
  await db.auditLog.create({ data: { userId, action, target, at: new Date() } });
}
