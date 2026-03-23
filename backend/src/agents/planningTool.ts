import { Type } from "@sinclair/typebox";
import type { ToolDefinition, AgentToolResult } from "@mariozechner/pi-coding-agent";
import { getProject, updateProject } from "../store/projects.js";
import { getRepository } from "../store/repositories.js";
import { getConnector } from "../connectors/types.js";
import type { Project } from "../models/types.js";
import path from "path";
import fs from "fs";

// ── Slug / Branch / Path helpers ──────────────────────────────────────────────

export function slugify(name: string): string {
  const result = name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return result || "project";
}

/** Extract issue number from first GitHub issue ref (e.g. "org/repo#42" → "42"). */
function githubIssuePrefix(project: Project): string {
  const ref = project.source.githubIssues?.[0];
  if (!ref) return "";
  const match = /#(\d+)$/.exec(ref);
  return match ? `issue-${match[1]}-` : "";
}

/** Extract ticket key from first Jira ticket (e.g. "PROJ-123"). */
function jiraPrefix(project: Project): string {
  const ticket = project.source.jiraTickets?.[0];
  return ticket ? `${ticket}-` : "";
}

export function buildPlanningBranch(project: Project): string {
  const prefix =
    project.source.type === "github" ? githubIssuePrefix(project) :
    project.source.type === "jira"   ? jiraPrefix(project) :
    "";
  // Suffix: first 5 chars of UUID, strip non-alphanumeric
  const suffix = project.id.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5);
  const slug = slugify(project.name).slice(0, 30).replace(/-+$/, "");
  return `harness/${prefix}${slug}-${suffix}`;
}

export function buildPlanningFilePath(
  type: "spec" | "plan",
  date: string,
  slug: string
): string {
  const dir = type === "spec" ? "docs/superpowers/specs" : "docs/superpowers/plans";
  const suffix = type === "spec" ? "design" : "plan";
  return `${dir}/${date}-${slug}-${suffix}.md`;
}

// ── Tool factory ──────────────────────────────────────────────────────────────

const WritePlanningDocumentParams = Type.Object({
  type: Type.Union([Type.Literal("spec"), Type.Literal("plan")]),
  content: Type.String({ description: "Full Markdown content of the document" }),
});

export function createWritePlanningDocumentTool(
  projectId: string,
  dataDir: string
): ToolDefinition<typeof WritePlanningDocumentParams> {
  return {
    name: "write_planning_document",
    label: "Write Planning Document",
    description:
      'Write a planning document to the project\'s planning branch in the primary repository. ' +
      'Call with type "spec" first to write the design spec and open the PR. ' +
      'Call with type "plan" after spec is approved to write the implementation plan. ' +
      'Returns the PR URL.',
    parameters: WritePlanningDocumentParams,
    async execute(_toolCallId, { type, content }) {
      const result = await handleWritePlanningDocument(projectId, type, content, dataDir);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: {},
      } satisfies AgentToolResult<unknown>;
    },
  };
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function handleWritePlanningDocument(
  projectId: string,
  type: "spec" | "plan",
  content: string,
  dataDir: string
): Promise<{ prUrl: string } | { error: string }> {
  const project = getProject(projectId);
  if (!project) return { error: `Project not found: ${projectId}` };

  const primaryRepoId = project.primaryRepositoryId ?? project.repositoryIds[0];
  if (!primaryRepoId) return { error: "Project has no primary repository" };

  const repo = getRepository(primaryRepoId);
  if (!repo) return { error: `Repository not found: ${primaryRepoId}` };

  const connector = getConnector(repo.provider);
  const date = project.createdAt.slice(0, 10); // YYYY-MM-DD
  const slug = slugify(project.name);

  try {
    if (type === "spec") {
      const branch = buildPlanningBranch(project);
      const filePath = buildPlanningFilePath("spec", date, slug);

      // Commit spec (createBranch=true creates branch from defaultBranch if needed)
      await connector.commitFile(repo, branch, filePath, content, `docs: add design spec for ${project.name}`, true);

      // Commit master session log snapshot alongside the spec
      const sessionLogSrc = path.join(dataDir, "sessions", projectId, "master.jsonl");
      if (fs.existsSync(sessionLogSrc)) {
        try {
          const log = await fs.promises.readFile(sessionLogSrc, "utf-8");
          await connector.commitFile(repo, branch, ".harness/logs/master/session.jsonl", log,
            "chore: add master agent log snapshot");
        } catch (logErr) {
          console.warn(`[planningTool] Failed to commit session log (non-fatal):`, logErr);
        }
      }

      // Create or reuse PR
      let prUrl: string;
      let prNumber: number;

      const harnessPrTitle = `[Harness] ${project.name}`;
      // Use HARNESS_UI_BASE_URL env var for the harness UI link; omit if not set
      const harnessUiBase = process.env.HARNESS_UI_BASE_URL ?? "";
      const uiProjectUrl = harnessUiBase ? `${harnessUiBase}/projects/${projectId}/chat` : "";

      try {
        const prResult = await connector.createPullRequest(repo, {
          title: harnessPrTitle,
          description: `Planning PR for harness project.${uiProjectUrl ? `\n\nView project: ${uiProjectUrl}` : ""}`,
          headBranch: branch,
          baseBranch: repo.defaultBranch,
        });
        prUrl = prResult.url;
        prNumber = parseInt(prResult.id, 10);
        if (isNaN(prNumber)) {
          return { error: `PR id is not a valid number: ${prResult.id}` };
        }
      } catch (prErr) {
        // PR might already exist — try to find it via listing (not implemented)
        // For now, surface the error to the agent
        return { error: `Failed to create PR: ${prErr instanceof Error ? prErr.message : String(prErr)}` };
      }

      updateProject(projectId, {
        primaryRepositoryId: primaryRepoId,
        planningBranch: branch,
        planningPr: { number: prNumber, url: prUrl },
        status: "awaiting_spec_approval",
      });

      return { prUrl };
    }

    if (type === "plan") {
      if (!project.planningBranch || !project.planningPr) {
        return { error: 'Spec must be written first — call write_planning_document with type "spec" before "plan".' };
      }

      const filePath = buildPlanningFilePath("plan", date, slug);
      await connector.commitFile(repo, project.planningBranch, filePath, content,
        `docs: add implementation plan for ${project.name}`);

      // Update master session log snapshot
      const sessionLogSrc = path.join(dataDir, "sessions", projectId, "master.jsonl");
      if (fs.existsSync(sessionLogSrc)) {
        try {
          const log = await fs.promises.readFile(sessionLogSrc, "utf-8");
          await connector.commitFile(repo, project.planningBranch, ".harness/logs/master/session.jsonl", log,
            "chore: update master agent log snapshot");
        } catch (logErr) {
          console.warn(`[planningTool] Failed to commit session log (non-fatal):`, logErr);
        }
      }

      // Store plan content and parse tasks so dispatchTasks can find them at execution time.
      // Import parsePlan lazily to avoid circular dependency.
      const { parsePlan } = await import("./planParser.js");
      const { listRepositories } = await import("../store/repositories.js");
      const allRepos = listRepositories();
      const tasks = parsePlan(projectId, content, allRepos);
      const planRecord = {
        id: project.plan?.id ?? project.id + "-plan",
        projectId,
        content,
        tasks,
      };

      updateProject(projectId, { plan: planRecord, status: "awaiting_plan_approval" });

      return { prUrl: project.planningPr.url };
    }

    return { error: `Unknown document type: ${type as string}` };
  } catch (error) {
    return { error: `VCS error: ${error instanceof Error ? error.message : String(error)}` };
  }
}
