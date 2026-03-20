import { randomUUID } from "crypto";
import type { PlanTask, Repository } from "../models/types.js";

export function parsePlan(projectId: string, markdown: string, repositories: Pick<Repository, "id" | "name">[]): PlanTask[] {
  const repoByName = new Map(repositories.map((r) => [r.name.toLowerCase(), r.id]));
  const tasks: PlanTask[] = [];
  const taskBlockRegex = /^###\s+Task\s+\d+:\s+.+?\n([\s\S]*?)(?=^###\s+Task\s+\d+:|$)/gm;
  for (const match of markdown.matchAll(taskBlockRegex)) {
    const block = match[0];
    const repoMatch = /\*\*Repository:\*\*\s+(.+)/i.exec(block);
    const descMatch = /\*\*Description:\*\*\s*\n([\s\S]+?)(?=\n\*\*|\n###|$)/i.exec(block);
    if (!repoMatch) continue;
    const repoName = repoMatch[1].trim();
    const repositoryId = repoByName.get(repoName.toLowerCase());
    if (!repositoryId) continue;
    const description = descMatch ? descMatch[1].trim() : block.trim();
    tasks.push({ id: randomUUID(), repositoryId, description, status: "pending" });
  }
  return tasks;
}
