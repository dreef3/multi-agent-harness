import type { Request, Response, NextFunction } from "express";
import { writeAuditEntry } from "../store/auditLog.js";

interface Resource {
  type: string;
  id: string;
}

function parseResource(method: string, path: string): Resource | null {
  // Only log mutations
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return null;

  // Match /api/projects/:id
  const projectsDetail = path.match(/^\/api\/projects\/([^/]+)(?:\/|$)/);
  if (projectsDetail) return { type: "project", id: projectsDetail[1] };

  // Match /api/projects (collection)
  if (path.match(/^\/api\/projects\/?$/)) return { type: "project", id: "*" };

  // Match /api/repositories/:id
  const reposDetail = path.match(/^\/api\/repositories\/([^/]+)(?:\/|$)/);
  if (reposDetail) return { type: "repository", id: reposDetail[1] };

  if (path.match(/^\/api\/repositories\/?$/)) return { type: "repository", id: "*" };

  // Match /api/projects/:id/tasks
  const tasks = path.match(/^\/api\/projects\/([^/]+)\/tasks/);
  if (tasks) return { type: "task", id: tasks[1] };

  // Fallback: use last path segment as id
  const parts = path.replace(/^\/api\//, "").split("/");
  return { type: parts[0] ?? "unknown", id: parts[1] ?? "*" };
}

export function auditLog() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const resource = parseResource(req.method, req.path);
    if (!resource) {
      next();
      return;
    }

    // Intercept res.json to capture status after response
    const originalJson = res.json.bind(res);
    res.json = function(body: unknown) {
      const result = originalJson(body);
      // Only log successful mutations (status < 400)
      if (res.statusCode < 400) {
        const details = req.body && Object.keys(req.body).length > 0
          ? JSON.stringify(req.body).slice(0, 500)
          : undefined;
        writeAuditEntry({
          userId: req.user?.sub,
          action: `${resource.type}.${req.method.toLowerCase()}`,
          resourceType: resource.type,
          resourceId: resource.id,
          details,
        }).catch(() => {}); // fire-and-forget — don't fail request on audit error
      }
      return result;
    };

    next();
  };
}
