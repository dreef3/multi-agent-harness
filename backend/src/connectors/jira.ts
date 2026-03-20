import { ConnectorError } from "../connectors/types.js";

export interface JiraIssue {
  key: string;
  summary: string;
  description?: string;
  status: string;
  priority?: string;
  assignee?: string;
  reporter?: string;
  created: string;
  updated: string;
  labels: string[];
  issuetype: string;
}

interface JiraSearchResponse {
  issues: Array<{
    key: string;
    fields: {
      summary: string;
      description?: string | { content?: Array<{ content?: Array<{ text?: string }> }> };
      status: { name: string };
      priority?: { name: string };
      assignee?: { displayName: string };
      reporter?: { displayName: string };
      created: string;
      updated: string;
      labels: string[];
      issuetype: { name: string };
    };
  }>;
  total: number;
}

interface JiraIssueResponse {
  key: string;
  fields: {
    summary: string;
    description?: string | { content?: Array<{ content?: Array<{ text?: string }> }> };
    status: { name: string };
    priority?: { name: string };
    assignee?: { displayName: string };
    reporter?: { displayName: string };
    created: string;
    updated: string;
    labels: string[];
    issuetype: { name: string };
  };
}

export class JiraConnector {
  private getToken(): string {
    const token = process.env.JIRA_TOKEN;
    if (!token) {
      throw new ConnectorError("JIRA_TOKEN environment variable not set", "jira");
    }
    return token;
  }

  private getBaseUrl(): string {
    const baseUrl = process.env.JIRA_BASE_URL;
    if (!baseUrl) {
      throw new ConnectorError("JIRA_BASE_URL environment variable not set", "jira");
    }
    return baseUrl.replace(/\/$/, ""); // Remove trailing slash if present
  }

  private getAuthHeaders(): Record<string, string> {
    const token = this.getToken();
    return {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
    };
  }

  private async fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
    const response = await fetch(url, {
      ...options,
      headers: {
        ...this.getAuthHeaders(),
        ...(options?.headers ?? {}),
      },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "Unknown error");
      throw new Error(`HTTP ${response.status}: ${text}`);
    }

    return response.json() as Promise<T>;
  }

  private extractDescription(description: unknown): string | undefined {
    if (typeof description === "string") {
      return description;
    }
    if (typeof description === "object" && description !== null) {
      // Handle Atlassian Document Format (ADF)
      const adf = description as { content?: Array<{ content?: Array<{ text?: string }> }> };
      if (Array.isArray(adf.content)) {
        const texts: string[] = [];
        for (const block of adf.content) {
          if (Array.isArray(block.content)) {
            for (const inline of block.content) {
              if (inline.text) {
                texts.push(inline.text);
              }
            }
          }
        }
        return texts.join("\n") || undefined;
      }
    }
    return undefined;
  }

  private mapIssue(issue: JiraIssueResponse): JiraIssue {
    const fields = issue.fields;
    return {
      key: issue.key,
      summary: fields.summary,
      description: this.extractDescription(fields.description),
      status: fields.status.name,
      priority: fields.priority?.name,
      assignee: fields.assignee?.displayName,
      reporter: fields.reporter?.displayName,
      created: fields.created,
      updated: fields.updated,
      labels: fields.labels,
      issuetype: fields.issuetype.name,
    };
  }

  /**
   * Search for JIRA issues using JQL
   * @param jql - JQL query string
   * @param maxResults - Maximum number of results (default 50)
   * @returns Array of JiraIssue objects
   */
  async searchIssues(jql: string, maxResults = 50): Promise<JiraIssue[]> {
    const baseUrl = this.getBaseUrl();

    try {
      const url = new URL(`${baseUrl}/rest/api/2/search`);
      url.searchParams.set("jql", jql);
      url.searchParams.set("maxResults", String(maxResults));
      url.searchParams.set("fields", "summary,description,status,priority,assignee,reporter,created,updated,labels,issuetype");

      const response = await this.fetchJson<JiraSearchResponse>(url.toString());

      return response.issues.map(issue => this.mapIssue(issue));
    } catch (error) {
      throw new ConnectorError(
        `Failed to search issues: ${error instanceof Error ? error.message : String(error)}`,
        "jira",
        error
      );
    }
  }

  /**
   * Get a single JIRA issue by key
   * @param issueKey - Issue key (e.g., "PROJ-123")
   * @returns JiraIssue object
   */
  async getIssue(issueKey: string): Promise<JiraIssue> {
    const baseUrl = this.getBaseUrl();

    try {
      const url = new URL(`${baseUrl}/rest/api/2/issue/${issueKey}`);
      url.searchParams.set("fields", "summary,description,status,priority,assignee,reporter,created,updated,labels,issuetype");

      const response = await this.fetchJson<JiraIssueResponse>(url.toString());

      return this.mapIssue(response);
    } catch (error) {
      throw new ConnectorError(
        `Failed to get issue: ${error instanceof Error ? error.message : String(error)}`,
        "jira",
        error
      );
    }
  }

  /**
   * Format an array of JIRA issues as context string for master agent prompt
   * @param issues - Array of JiraIssue objects
   * @returns Formatted context string
   */
  formatIssuesAsContext(issues: JiraIssue[]): string {
    if (issues.length === 0) {
      return "No JIRA issues found.";
    }

    const lines: string[] = [
      `## JIRA Issues (${issues.length} found)`,
      "",
    ];

    for (const issue of issues) {
      lines.push(`### ${issue.key}: ${issue.summary}`);
      lines.push(`- **Type:** ${issue.issuetype}`);
      lines.push(`- **Status:** ${issue.status}`);
      if (issue.priority) {
        lines.push(`- **Priority:** ${issue.priority}`);
      }
      if (issue.assignee) {
        lines.push(`- **Assignee:** ${issue.assignee}`);
      }
      if (issue.labels.length > 0) {
        lines.push(`- **Labels:** ${issue.labels.join(", ")}`);
      }
      if (issue.description) {
        lines.push("");
        lines.push("**Description:**");
        lines.push(issue.description);
      }
      lines.push("");
    }

    return lines.join("\n");
  }
}
