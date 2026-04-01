import { getAdapter } from "./db.js";
import type { PullRequest, ReviewComment } from "../models/types.js";

const db = () => getAdapter();

interface PullRequestRow {
  id: string;
  project_id: string;
  repository_id: string;
  agent_session_id: string;
  provider: string;
  external_id: string;
  url: string;
  branch: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface ReviewCommentRow {
  id: string;
  pull_request_id: string;
  external_id: string;
  author: string;
  body: string;
  file_path: string | null;
  line_number: number | null;
  status: string;
  received_at: string;
  updated_at: string;
}

function prFromRow(row: PullRequestRow): PullRequest {
  return {
    id: row.id,
    projectId: row.project_id,
    repositoryId: row.repository_id,
    agentSessionId: row.agent_session_id,
    provider: row.provider as PullRequest["provider"],
    externalId: row.external_id,
    url: row.url,
    branch: row.branch,
    status: row.status as PullRequest["status"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function commentFromRow(row: ReviewCommentRow): ReviewComment {
  return {
    id: row.id,
    pullRequestId: row.pull_request_id,
    externalId: row.external_id,
    author: row.author,
    body: row.body,
    filePath: row.file_path ?? undefined,
    lineNumber: row.line_number ?? undefined,
    status: row.status as ReviewComment["status"],
    receivedAt: row.received_at,
    updatedAt: row.updated_at,
  };
}

export async function insertPullRequest(pr: PullRequest): Promise<void> {
  await db().execute(
    `INSERT INTO pull_requests (id, project_id, repository_id, agent_session_id, provider, external_id, url, branch, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [pr.id, pr.projectId, pr.repositoryId, pr.agentSessionId, pr.provider,
     pr.externalId, pr.url, pr.branch, pr.status, pr.createdAt, pr.updatedAt]
  );
}

export async function getPullRequest(id: string): Promise<PullRequest | null> {
  const rows = await db().query<PullRequestRow>("SELECT * FROM pull_requests WHERE id = ?", [id]);
  return rows[0] ? prFromRow(rows[0]) : null;
}

export async function getPullRequestByExternalId(externalId: string): Promise<PullRequest | null> {
  const rows = await db().query<PullRequestRow>("SELECT * FROM pull_requests WHERE external_id = ?", [externalId]);
  return rows[0] ? prFromRow(rows[0]) : null;
}

export async function listPullRequestsByProject(projectId: string): Promise<PullRequest[]> {
  const rows = await db().query<PullRequestRow>(
    "SELECT * FROM pull_requests WHERE project_id = ? ORDER BY created_at DESC", [projectId]
  );
  return rows.map(prFromRow);
}

export async function updatePullRequest(id: string, updates: Partial<Omit<PullRequest, "id">>): Promise<void> {
  const existing = await getPullRequest(id);
  if (!existing) throw new Error(`PullRequest not found: ${id}`);
  const merged = { ...existing, ...updates, id, updatedAt: new Date().toISOString() };
  await db().execute(
    `UPDATE pull_requests SET
      project_id = ?,
      repository_id = ?,
      agent_session_id = ?,
      provider = ?,
      external_id = ?,
      url = ?,
      branch = ?,
      status = ?,
      updated_at = ?
     WHERE id = ?`,
    [merged.projectId, merged.repositoryId, merged.agentSessionId, merged.provider,
     merged.externalId, merged.url, merged.branch, merged.status, merged.updatedAt, merged.id]
  );
}

/** Returns true if the comment was newly inserted, false if it already existed. */
export async function upsertReviewComment(comment: ReviewComment): Promise<boolean> {
  const existing = await db().query<ReviewCommentRow>(
    "SELECT * FROM review_comments WHERE external_id = ?", [comment.externalId]
  );

  if (existing[0]) {
    await db().execute(
      `UPDATE review_comments SET
        pull_request_id = ?,
        author = ?,
        body = ?,
        file_path = ?,
        line_number = ?,
        status = ?,
        updated_at = ?
       WHERE external_id = ?`,
      [comment.pullRequestId, comment.author, comment.body,
       comment.filePath ?? null, comment.lineNumber ?? null,
       comment.status, new Date().toISOString(), comment.externalId]
    );
    return false;
  } else {
    await db().execute(
      `INSERT INTO review_comments (id, pull_request_id, external_id, author, body, file_path, line_number, status, received_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [comment.id, comment.pullRequestId, comment.externalId, comment.author, comment.body,
       comment.filePath ?? null, comment.lineNumber ?? null,
       comment.status, comment.receivedAt, comment.updatedAt]
    );
    return true;
  }
}

export async function getPendingComments(pullRequestId: string): Promise<ReviewComment[]> {
  const rows = await db().query<ReviewCommentRow>(
    "SELECT * FROM review_comments WHERE pull_request_id = ? AND status = 'pending' ORDER BY received_at ASC",
    [pullRequestId]
  );
  return rows.map(commentFromRow);
}

export async function markCommentsStatus(
  pullRequestId: string,
  commentIds: string[],
  status: ReviewComment["status"]
): Promise<void> {
  const updatedAt = new Date().toISOString();
  for (const id of commentIds) {
    await db().execute(
      `UPDATE review_comments SET status = ?, updated_at = ? WHERE id = ? AND pull_request_id = ?`,
      [status, updatedAt, id, pullRequestId]
    );
  }
}

export async function listAllPendingComments(): Promise<ReviewComment[]> {
  const rows = await db().query<ReviewCommentRow>(
    "SELECT * FROM review_comments WHERE status = 'pending' ORDER BY received_at ASC"
  );
  return rows.map(commentFromRow);
}
