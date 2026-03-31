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

export function insertPullRequest(pr: PullRequest): void {
  db()
    .prepare(
      `INSERT INTO pull_requests (id, project_id, repository_id, agent_session_id, provider, external_id, url, branch, status, created_at, updated_at)
       VALUES (@id, @projectId, @repositoryId, @agentSessionId, @provider, @externalId, @url, @branch, @status, @createdAt, @updatedAt)`
    )
    .run({
      id: pr.id,
      projectId: pr.projectId,
      repositoryId: pr.repositoryId,
      agentSessionId: pr.agentSessionId,
      provider: pr.provider,
      externalId: pr.externalId,
      url: pr.url,
      branch: pr.branch,
      status: pr.status,
      createdAt: pr.createdAt,
      updatedAt: pr.updatedAt,
    });
}

export function getPullRequest(id: string): PullRequest | null {
  const row = db().prepare("SELECT * FROM pull_requests WHERE id = ?").get(id) as PullRequestRow | null;
  return row ? prFromRow(row) : null;
}

export function getPullRequestByExternalId(externalId: string): PullRequest | null {
  const row = db().prepare("SELECT * FROM pull_requests WHERE external_id = ?").get(externalId) as PullRequestRow | null;
  return row ? prFromRow(row) : null;
}

export function listPullRequestsByProject(projectId: string): PullRequest[] {
  const rows = db()
    .prepare("SELECT * FROM pull_requests WHERE project_id = ? ORDER BY created_at DESC")
    .all(projectId) as unknown as PullRequestRow[];
  return rows.map(prFromRow);
}

export function updatePullRequest(id: string, updates: Partial<Omit<PullRequest, "id">>): void {
  const existing = getPullRequest(id);
  if (!existing) throw new Error(`PullRequest not found: ${id}`);
  const merged = { ...existing, ...updates, id, updatedAt: new Date().toISOString() };
  db()
    .prepare(
      `UPDATE pull_requests SET
        project_id = @projectId,
        repository_id = @repositoryId,
        agent_session_id = @agentSessionId,
        provider = @provider,
        external_id = @externalId,
        url = @url,
        branch = @branch,
        status = @status,
        updated_at = @updatedAt
       WHERE id = @id`
    )
    .run({
      id: merged.id,
      projectId: merged.projectId,
      repositoryId: merged.repositoryId,
      agentSessionId: merged.agentSessionId,
      provider: merged.provider,
      externalId: merged.externalId,
      url: merged.url,
      branch: merged.branch,
      status: merged.status,
      updatedAt: merged.updatedAt,
    });
}

/** Returns true if the comment was newly inserted, false if it already existed. */
export function upsertReviewComment(comment: ReviewComment): boolean {
  const existing = db()
    .prepare("SELECT * FROM review_comments WHERE external_id = ?")
    .get(comment.externalId) as ReviewCommentRow | null;

  if (existing) {
    db()
      .prepare(
        `UPDATE review_comments SET
          pull_request_id = @pullRequestId,
          author = @author,
          body = @body,
          file_path = @filePath,
          line_number = @lineNumber,
          status = @status,
          updated_at = @updatedAt
         WHERE external_id = @externalId`
      )
      .run({
        pullRequestId: comment.pullRequestId,
        author: comment.author,
        body: comment.body,
        filePath: comment.filePath ?? null,
        lineNumber: comment.lineNumber ?? null,
        status: comment.status,
        updatedAt: new Date().toISOString(),
        externalId: comment.externalId,
      });
    return false;
  } else {
    db()
      .prepare(
        `INSERT INTO review_comments (id, pull_request_id, external_id, author, body, file_path, line_number, status, received_at, updated_at)
         VALUES (@id, @pullRequestId, @externalId, @author, @body, @filePath, @lineNumber, @status, @receivedAt, @updatedAt)`
      )
      .run({
        id: comment.id,
        pullRequestId: comment.pullRequestId,
        externalId: comment.externalId,
        author: comment.author,
        body: comment.body,
        filePath: comment.filePath ?? null,
        lineNumber: comment.lineNumber ?? null,
        status: comment.status,
        receivedAt: comment.receivedAt,
        updatedAt: comment.updatedAt,
      });
    return true;
  }
}

export function getPendingComments(pullRequestId: string): ReviewComment[] {
  const rows = db()
    .prepare("SELECT * FROM review_comments WHERE pull_request_id = ? AND status = 'pending' ORDER BY received_at ASC")
    .all(pullRequestId) as unknown as ReviewCommentRow[];
  return rows.map(commentFromRow);
}

export function markCommentsStatus(
  pullRequestId: string,
  commentIds: string[],
  status: ReviewComment["status"]
): void {
  const stmt = db().prepare(
    `UPDATE review_comments SET status = @status, updated_at = @updatedAt WHERE id = @id AND pull_request_id = @pullRequestId`
  );
  const updatedAt = new Date().toISOString();
  for (const id of commentIds) {
    stmt.run({ id, status, updatedAt, pullRequestId });
  }
}

export function listAllPendingComments(): ReviewComment[] {
  const rows = db()
    .prepare("SELECT * FROM review_comments WHERE status = 'pending' ORDER BY received_at ASC")
    .all() as unknown as ReviewCommentRow[];
  return rows.map(commentFromRow);
}
