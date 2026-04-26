import * as vscode from "vscode";

const GITHUB_PROVIDER_ID = "github";
const GITHUB_API_URL = "https://api.github.com";
const GITHUB_SCOPES = ["repo", "read:user"];

export interface GitHubUser {
  login: string;
  id: number;
  avatar_url?: string;
}

export interface GitHubRepoTarget {
  owner: string;
  repo: string;
  branch: string;
  path: string;
}

export interface GitHubRepoContent {
  path: string;
  sha: string;
  content: string;
  html_url?: string;
  download_url?: string | null;
}

export interface GitHubRepository {
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
  html_url?: string;
}

type JsonObject = Record<string, unknown>;

export class GitHubService {
  private static instance: GitHubService;

  public static getInstance(): GitHubService {
    if (!GitHubService.instance) {
      GitHubService.instance = new GitHubService();
    }
    return GitHubService.instance;
  }

  public async isAuthenticated(): Promise<boolean> {
    try {
      const session = await this.getSession(false);
      return session !== undefined;
    } catch {
      return false;
    }
  }

  public async getSession(createIfNone = false): Promise<vscode.AuthenticationSession | undefined> {
    try {
      return await vscode.authentication.getSession(GITHUB_PROVIDER_ID, GITHUB_SCOPES, {
        createIfNone,
        silent: !createIfNone
      });
    } catch (error) {
      if (!createIfNone) {
        return undefined;
      }
      throw this.asError(error, "GitHub authentication is not available.");
    }
  }

  public async getAccessToken(createIfNone = false): Promise<string> {
    const session = await this.getSession(createIfNone);
    if (!session) {
      throw new Error("GitHub authentication is required.");
    }
    return session.accessToken;
  }

  public async getCurrentUser(): Promise<GitHubUser | null> {
    try {
      return await this.apiRequest<GitHubUser>("/user", "GET");
    } catch {
      return null;
    }
  }

  public async getRepository(owner: string, repo: string): Promise<GitHubRepository | null> {
    try {
      const data = await this.apiRequest<unknown>(`/repos/${this.encodePath(owner)}/${this.encodePath(repo)}`, "GET");
      return this.asRepository(data);
    } catch (error) {
      if (error instanceof Error && /not found/i.test(error.message)) {
        return null;
      }
      throw error;
    }
  }

  public async ensureUserRepository(
    repoName: string,
    options?: { private?: boolean; description?: string }
  ): Promise<{ owner: string; repo: GitHubRepository }> {
    const user = await this.getCurrentUser();
    if (!user?.login) {
      throw new Error("GitHub authentication is required.");
    }

    const existing = await this.getRepository(user.login, repoName);
    if (existing) {
      return { owner: user.login, repo: existing };
    }

    const created = await this.apiRequest<unknown>("/user/repos", "POST", {
      name: repoName,
      description: options?.description ?? "Shared TODO lists for Projects TODO Advanced",
      private: options?.private ?? true,
      auto_init: true,
      has_issues: false,
      has_wiki: false,
      has_projects: false
    });

    return { owner: user.login, repo: this.asRepository(created) };
  }

  public async getRepoContents(target: GitHubRepoTarget): Promise<GitHubRepoContent> {
    const data = await this.apiRequest<unknown>(
      `/repos/${this.encodePath(target.owner)}/${this.encodePath(target.repo)}/contents/${this.encodeContentPath(target.path)}?ref=${encodeURIComponent(target.branch)}`,
      "GET"
    );

    if (!this.isRecord(data) || typeof data.sha !== "string") {
      throw new Error("Unexpected GitHub contents response.");
    }

    const content = typeof data.content === "string" ? this.decodeBase64Content(data.content) : "";
    return {
      path: typeof data.path === "string" ? data.path : target.path,
      sha: data.sha,
      content,
      html_url: typeof data.html_url === "string" ? data.html_url : undefined,
      download_url: typeof data.download_url === "string" || data.download_url === null ? data.download_url : undefined
    };
  }

  public async putRepoContents(
    target: GitHubRepoTarget,
    content: string,
    message: string,
    sha?: string
  ): Promise<GitHubRepoContent> {
    const body: JsonObject = {
      message,
      content: Buffer.from(content, "utf8").toString("base64"),
      branch: target.branch
    };
    if (sha) {
      body.sha = sha;
    }

    const data = await this.apiRequest<unknown>(
      `/repos/${this.encodePath(target.owner)}/${this.encodePath(target.repo)}/contents/${this.encodeContentPath(target.path)}`,
      "PUT",
      body
    );

    return this.asRepoContent(data, target);
  }

  public async deleteRepoContents(target: GitHubRepoTarget, message: string, sha: string): Promise<void> {
    await this.apiRequest(
      `/repos/${this.encodePath(target.owner)}/${this.encodePath(target.repo)}/contents/${this.encodeContentPath(target.path)}`,
      "DELETE",
      {
        message,
        sha,
        branch: target.branch
      }
    );
  }

  public async fileExists(target: GitHubRepoTarget): Promise<boolean> {
    try {
      await this.getRepoContents(target);
      return true;
    } catch {
      return false;
    }
  }

  public async request<T>(path: string, method: string, body?: unknown): Promise<T> {
    return this.apiRequest<T>(path, method, body);
  }

  private async apiRequest<T>(path: string, method: string, body?: unknown): Promise<T> {
    const token = await this.getAccessToken(true);
    const response = await fetch(`${GITHUB_API_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });

    if (response.ok) {
      if (response.status === 204) {
        return undefined as T;
      }
      return (await response.json()) as T;
    }

    const message = await this.readErrorMessage(response);
    throw new Error(message);
  }

  private async readErrorMessage(response: Response): Promise<string> {
    const fallback = `GitHub API error: ${response.status}`;
    try {
      const data = await response.json();
      if (this.isRecord(data) && typeof data.message === "string") {
        if (response.status === 404) {
          return `${data.message} (check repository owner/name, branch, file path, and GitHub permissions)`;
        }
        if (response.status === 403 && typeof data.documentation_url === "string") {
          return `${data.message} (check GitHub permissions or rate limits)`;
        }
        return data.message;
      }
      return response.status === 404
        ? "GitHub resource not found. Check repository owner/name, branch, file path, and permissions."
        : fallback;
    } catch {
      return response.status === 404
        ? "GitHub resource not found. Check repository owner/name, branch, file path, and permissions."
        : fallback;
    }
  }

  private decodeBase64Content(value: string): string {
    const cleaned = value.replace(/\n/g, "");
    return Buffer.from(cleaned, "base64").toString("utf8");
  }

  private encodePath(value: string): string {
    return encodeURIComponent(value).replace(/%2F/g, "/");
  }

  private encodeContentPath(value: string): string {
    return value.split("/").map((part) => encodeURIComponent(part)).join("/");
  }

  private asRepoContent(data: unknown, target: GitHubRepoTarget): GitHubRepoContent {
    if (!this.isRecord(data) || typeof data.content !== "object") {
      throw new Error("Unexpected GitHub response.");
    }
    const content = data.content as Record<string, unknown>;
    return {
      path: typeof content.path === "string" ? content.path : target.path,
      sha: typeof content.sha === "string" ? content.sha : "",
      content: "",
      html_url: typeof content.html_url === "string" ? content.html_url : undefined,
      download_url:
        typeof content.download_url === "string" || content.download_url === null
          ? (content.download_url as string | null | undefined)
          : undefined
    };
  }

  private asRepository(data: unknown): GitHubRepository {
    if (!this.isRecord(data)) {
      throw new Error("Unexpected GitHub repository response.");
    }
    return {
      name: typeof data.name === "string" ? data.name : "",
      full_name: typeof data.full_name === "string" ? data.full_name : "",
      private: Boolean(data.private),
      default_branch: typeof data.default_branch === "string" ? data.default_branch : "main",
      html_url: typeof data.html_url === "string" ? data.html_url : undefined
    };
  }

  private isRecord(value: unknown): value is JsonObject {
    return typeof value === "object" && value !== null;
  }

  private asError(error: unknown, fallback: string): Error {
    if (error instanceof Error) {
      return error;
    }
    return new Error(fallback);
  }
}

export const githubService = GitHubService.getInstance();
