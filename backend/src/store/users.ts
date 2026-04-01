import { getAdapter } from "./db.js";

export interface User {
  id: string;        // OIDC sub
  email: string;
  displayName: string;
  roles: string[];   // stored as JSON in DB
  lastSeen: string;  // ISO-8601
  createdAt: string; // ISO-8601
}

export async function upsertUser(user: User): Promise<void> {
  await getAdapter().execute(
    `INSERT INTO users (id, email, display_name, roles, last_seen, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       email        = excluded.email,
       display_name = excluded.display_name,
       roles        = excluded.roles,
       last_seen    = excluded.last_seen`,
    [user.id, user.email, user.displayName, JSON.stringify(user.roles), user.lastSeen, user.createdAt]
  );
}

export async function getUser(id: string): Promise<User | null> {
  type UserRow = { id: string; email: string; display_name: string; roles: string; last_seen: string; created_at: string };
  const rows = await getAdapter().query<UserRow>("SELECT * FROM users WHERE id = ?", [id]);
  return rows[0] ? rowToUser(rows[0]) : null;
}

export async function listUsers(): Promise<User[]> {
  type UserRow = { id: string; email: string; display_name: string; roles: string; last_seen: string; created_at: string };
  const rows = await getAdapter().query<UserRow>("SELECT * FROM users ORDER BY last_seen DESC");
  return rows.map(rowToUser);
}

function rowToUser(row: { id: string; email: string; display_name: string; roles: string; last_seen: string; created_at: string }): User {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    roles: JSON.parse(row.roles ?? "[]"),
    lastSeen: row.last_seen,
    createdAt: row.created_at,
  };
}
