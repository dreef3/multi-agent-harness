const API_BASE = "/api";

export interface Project {
  id: string;
  name: string;
  description?: string;
  source?: string;
  repositoryIds?: string[];
  masterSessionPath?: string;
  status: "draft" | "planning" | "approved" | "executing" | "completed" | "error" | "brainstorming" | "awaiting_approval" | "cancelled";
  plan?: Plan;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  projectId: string;
  role: "user" | "assistant";
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
  health: () => fetchJson<{ status: string; timestamp: string }>(`${API_BASE}/health`),
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
    messages: {
      list: (projectId: string) =>
        fetchJson<Message[]>(`${API_BASE}/projects/${projectId}/messages`),
    },
    approve: (projectId: string) =>
      fetchJson<{ success: boolean; plan: unknown }>(`${API_BASE}/projects/${projectId}/approve`, {
        method: "POST",
      }),
    cancel: (projectId: string) =>
      fetchJson<{ success: boolean; status: string }>(`${API_BASE}/projects/${projectId}/cancel`, {
        method: "POST",
      }),
  },
  repositories: {
    list: () => fetchJson<unknown[]>(`${API_BASE}/repositories`),
    get: (id: string) => fetchJson<unknown>(`${API_BASE}/repositories/${id}`),
    create: (data: unknown) =>
      fetchJson<unknown>(`${API_BASE}/repositories`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    update: (id: string, data: unknown) =>
      fetchJson<unknown>(`${API_BASE}/repositories/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      fetch(`${API_BASE}/repositories/${id}`, { method: "DELETE" }),
  },
};
