import { getAdapter } from "./db.js";
import { randomUUID } from "crypto";

export interface AuditEntry {
  userId?: string;
  action: string;        // e.g. "project.create"
  resourceType: string;  // e.g. "project"
  resourceId: string;
  details?: string;      // truncated JSON body
}

export async function writeAuditEntry(entry: AuditEntry): Promise<void> {
  await getAdapter().execute(
    `INSERT INTO audit_log (id, timestamp, user_id, action, resource_type, resource_id, details)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      randomUUID(),
      new Date().toISOString(),
      entry.userId ?? null,
      entry.action,
      entry.resourceType,
      entry.resourceId,
      entry.details ?? "{}",
    ]
  );
}

export async function getAuditLog(options: {
  userId?: string;
  resourceType?: string;
  resourceId?: string;
  limit?: number;
} = {}): Promise<AuditEntry[]> {
  // Build query dynamically
  let sql = "SELECT * FROM audit_log WHERE 1=1";
  const params: unknown[] = [];
  if (options.userId) { sql += " AND user_id = ?"; params.push(options.userId); }
  if (options.resourceType) { sql += " AND resource_type = ?"; params.push(options.resourceType); }
  if (options.resourceId) { sql += " AND resource_id = ?"; params.push(options.resourceId); }
  sql += " ORDER BY timestamp DESC LIMIT ?";
  params.push(options.limit ?? 100);

  type AuditRow = { id: string; timestamp: string; user_id: string | null; action: string; resource_type: string; resource_id: string; details: string };
  const rows = await getAdapter().query<AuditRow>(sql, params);
  return rows.map(row => ({
    userId: row.user_id ?? undefined,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    details: (row.details && row.details !== "{}") ? row.details : undefined,
  }));
}
