import { randomUUID } from "crypto";
import type { PlanTask, Repository } from "../models/types.js";

export function parsePlan(projectId: string, markdown: string, repositories: Pick<Repository, "id" | "name">[]): PlanTask[] {
  const repoByName = new Map(repositories.map((r) => [r.name.toLowerCase(), r.id]));
  console.log(`[planParser:${projectId}] known repos: [${[...repoByName.keys()].join(", ")}]`);
  console.log(`[planParser:${projectId}] plan markdown length=${markdown.length}`);

  const tasks: PlanTask[] = [];
  const taskBlockRegex = /^#{2,3}\s+Task\s+\d+:\s+.+?\n([\s\S]*?)(?=^#{2,3}\s+Task\s+\d+:|(?![\s\S]))/gm;
  const allBlocks = [...markdown.matchAll(taskBlockRegex)];
  console.log(`[planParser:${projectId}] task blocks found: ${allBlocks.length}`);

  for (const match of allBlocks) {
    const block = match[0];
    const titleMatch = /^###\s+Task\s+\d+:\s+(.+)/m.exec(block);
    const title = titleMatch ? titleMatch[1].trim() : "(unknown)";
    const repoMatch = /\*\*Repository:\*\*\s+(.+)/i.exec(block);
    const descMatch = /\*\*Description:\*\*\s*\n([\s\S]+?)(?=\n\*\*|\n###|$)/i.exec(block);
    if (!repoMatch) {
      console.warn(`[planParser:${projectId}] task "${title}" skipped — no **Repository:** field found`);
      continue;
    }
    const repoName = repoMatch[1].trim();
    const repositoryId = repoByName.get(repoName.toLowerCase());
    if (!repositoryId) {
      console.warn(`[planParser:${projectId}] task "${title}" skipped — repo "${repoName}" not found in known repos`);
      continue;
    }
    const description = descMatch ? descMatch[1].trim() : block.trim();
    const taskId = randomUUID();
    console.log(`[planParser:${projectId}] parsed task id=${taskId} title="${title}" repo="${repoName}"`);
    tasks.push({ id: taskId, repositoryId, description, status: "pending" });
  }

  console.log(`[planParser:${projectId}] total tasks parsed: ${tasks.length}`);
  return tasks;
}
