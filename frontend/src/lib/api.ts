const API_BASE = "/api";

export interface Project {
  id: string;
  name: string;
  description: string;
  status: "draft" | "planning" | "approved" | "executing" | "completed" | "error";
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  projectId: string;
  role: "user" | "agent" | "system";
  content: string;
  timestamp: string;
}

export interface Plan {
  id: string;
  projectId: string;
  tasks: Task[];
  status: "draft" | "pending_approval" | "approved" | "rejected";
  createdAt: string;
}

export interface Task {
  id: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  dependencies: string[];
}

export interface Settings {
  masterAgent: {
    model: string;
    temperature: number;
    maxTokens: number;
  };
  workerAgents: {
    model: string;
    temperature: number;
    maxTokens: number;
  };
}

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
    },
    ...options,
  });
  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

export const api = {
  projects: {
    list: () => fetchJson<Project[]>(`${API_BASE}/projects`),
    get: (id: string) => fetchJson<Project>(`${API_BASE}/projects/${id}`),
    create: (data: { name: string; description: string }) =>
      fetchJson<Project>(`${API_BASE}/projects`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      fetch(`${API_BASE}/projects/${id}`, { method: "DELETE" }),
  },
  messages: {
    list: (projectId: string) =>
      fetchJson<Message[]>(`${API_BASE}/projects/${projectId}/messages`),
    send: (projectId: string, content: string) =>
      fetchJson<Message>(`${API_BASE}/projects/${projectId}/messages`, {
        method: "POST",
        body: JSON.stringify({ content }),
      }),
  },
  plan: {
    get: (projectId: string) =>
      fetchJson<Plan>(`${API_BASE}/projects/${projectId}/plan`),
    approve: (projectId: string) =>
      fetchJson<Plan>(`${API_BASE}/projects/${projectId}/plan/approve`, {
        method: "POST",
      }),
    reject: (projectId: string, feedback: string) =>
      fetchJson<Plan>(`${API_BASE}/projects/${projectId}/plan/reject`, {
        method: "POST",
        body: JSON.stringify({ feedback }),
      }),
  },
  execution: {
    start: (projectId: string) =>
      fetchJson<{ success: boolean }>(
        `${API_BASE}/projects/${projectId}/execute`,
        { method: "POST" }
      ),
    stop: (projectId: string) =>
      fetchJson<{ success: boolean }>(
        `${API_BASE}/projects/${projectId}/execute/stop`,
        { method: "POST" }
      ),
  },
  settings: {
    get: () => fetchJson<Settings>(`${API_BASE}/settings`),
    update: (data: Settings) =>
      fetchJson<Settings>(`${API_BASE}/settings`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
  },
};
