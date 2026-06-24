import * as vscode from "vscode";

const GITHUB_PROVIDER_ID = "github";
const GITHUB_API_URL = "https://api.github.com";
const GITHUB_SCOPES = ["repo", "read:user"];
const GITHUB_MANAGED_REPO_TOPIC = "todo-extension";
const PREFERRED_ACCOUNT_KEY = "todoListPro.auth.githubAccount";

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

export interface GitHubRepositorySummary {
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
  description?: string | null;
  topics: string[];
  html_url?: string;
  owner: string;
}

export interface GitHubRepositoryInvitation {
  id: number;
  repository: GitHubRepositorySummary;
  inviter?: GitHubUser;
  invitee?: GitHubUser;
  permissions?: string;
  created_at?: string;
  html_url?: string;
}

export interface GitHubCollaboratorPermission {
  permission: string;
  role_name?: string;
  user?: GitHubUser;
}

export interface GitHubRepositoryCollaborator {
  login: string;
  id: number;
  avatar_url?: string;
}

export interface GitHubRepositoryFileEntry {
  name: string;
  path: string;
  sha?: string;
  type?: string;
}

type JsonObject = Record<string, unknown>;

export class GitHubService {
  private static instance: GitHubService;
  private context?: vscode.ExtensionContext;
  private cachedSession?: vscode.AuthenticationSession;
  private sessionPromise?: Promise<vscode.AuthenticationSession | undefined>;
  private preferredAccount?: vscode.AuthenticationSessionAccountInformation;

  public static getInstance(): GitHubService {
    if (!GitHubService.instance) {
      GitHubService.instance = new GitHubService();
    }
    return GitHubService.instance;
  }

  public initialize(context: vscode.ExtensionContext): void {
    if (this.context) {
      return;
    }

    this.context = context;
    this.preferredAccount = context.globalState.get<vscode.AuthenticationSessionAccountInformation | undefined>(PREFERRED_ACCOUNT_KEY);
    context.globalState.setKeysForSync([PREFERRED_ACCOUNT_KEY]);
    context.subscriptions.push(
      vscode.authentication.onDidChangeSessions((event) => {
        if (event.provider.id !== GITHUB_PROVIDER_ID) {
          return;
        }
        this.handleSessionChange(event);
      })
    );
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
    const session = await this.resolveSession(createIfNone);
    if (session) {
      this.cachedSession = session;
      await this.persistPreferredAccount(session.account);
    }
    return session;
  }

  public async getAccessToken(createIfNone = false): Promise<string> {
    const session = await this.getSession(createIfNone);
    if (!session) {
      throw new Error("GitHub authentication is required.");
    }
    return session.accessToken;
  }

  public async getCurrentUser(createIfNone = false): Promise<GitHubUser | null> {
    try {
      return await this.apiRequest<GitHubUser>("/user", "GET", undefined, createIfNone);
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
    const user = await this.getCurrentUser(true);
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

  public async listCurrentUserRepositories(): Promise<GitHubRepositorySummary[]> {
    const data = await this.fetchPaged<unknown>("/user/repos?affiliation=owner,collaborator&sort=updated", "GET");
    return data.map((item) => this.asRepositorySummary(item));
  }

  public async getRepositoryTopics(owner: string, repo: string): Promise<string[]> {
    const data = await this.apiRequest<unknown>(
      `/repos/${this.encodePath(owner)}/${this.encodePath(repo)}/topics`,
      "GET"
    );
    if (!this.isRecord(data) || !Array.isArray(data.names)) {
      return [];
    }
    return data.names.filter((item): item is string => typeof item === "string");
  }

  public async setRepositoryTopicAndDescription(
    owner: string,
    repo: string,
    options: { description?: string; topics?: string[] }
  ): Promise<void> {
    await this.apiRequest(
      `/repos/${this.encodePath(owner)}/${this.encodePath(repo)}`,
      "PATCH",
      {
        description: options.description,
        default_branch: undefined,
        has_issues: false,
        has_projects: false,
        has_wiki: false,
        topics: options.topics ?? [GITHUB_MANAGED_REPO_TOPIC]
      }
    );
  }

  public async listRepositoryFiles(target: GitHubRepoTarget, directoryPath: string): Promise<GitHubRepositoryFileEntry[]> {
    const data = await this.apiRequest<unknown>(
      `/repos/${this.encodePath(target.owner)}/${this.encodePath(target.repo)}/contents/${this.encodeContentPath(directoryPath)}?ref=${encodeURIComponent(target.branch)}`,
      "GET"
    );
    if (!Array.isArray(data)) {
      return [];
    }
    return data
      .filter((item) => this.isRecord(item))
      .map((item) => ({
        name: typeof item.name === "string" ? item.name : "",
        path: typeof item.path === "string" ? item.path : directoryPath,
        sha: typeof item.sha === "string" ? item.sha : undefined,
        type: typeof item.type === "string" ? item.type : undefined
      }))
      .filter((item) => item.name.length > 0);
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

  public async inviteCollaborator(owner: string, repo: string, username: string, permission = "push"): Promise<void> {
    await this.apiRequest(
      `/repos/${this.encodePath(owner)}/${this.encodePath(repo)}/collaborators/${this.encodePath(username)}`,
      "PUT",
      { permission }
    );
  }

  public async listRepositoryInvitations(owner: string, repo: string): Promise<GitHubRepositoryInvitation[]> {
    const data = await this.apiRequest<unknown[]>(
      `/repos/${this.encodePath(owner)}/${this.encodePath(repo)}/invitations`,
      "GET"
    );
    return data.map((item) => this.asRepositoryInvitation(item));
  }

  public async listCurrentUserRepositoryInvitations(): Promise<GitHubRepositoryInvitation[]> {
    const data = await this.apiRequest<unknown[]>("/user/repository_invitations?per_page=100", "GET");
    return data.map((item) => this.asRepositoryInvitation(item));
  }

  public async acceptRepositoryInvitation(invitationId: number): Promise<void> {
    await this.apiRequest(`/user/repository_invitations/${invitationId}`, "PATCH");
  }

  public async declineRepositoryInvitation(invitationId: number): Promise<void> {
    await this.apiRequest(`/user/repository_invitations/${invitationId}`, "DELETE");
  }

  public async getCollaboratorPermission(owner: string, repo: string, username: string): Promise<string | null> {
    try {
      const data = await this.apiRequest<unknown>(
        `/repos/${this.encodePath(owner)}/${this.encodePath(repo)}/collaborators/${this.encodePath(username)}/permission`,
        "GET"
      );
      return this.isRecord(data) && typeof data.permission === "string" ? data.permission : null;
    } catch (error) {
      if (error instanceof Error && /not found/i.test(error.message)) {
        return null;
      }
      throw error;
    }
  }

  public async listRepositoryCollaborators(owner: string, repo: string): Promise<GitHubRepositoryCollaborator[]> {
    const data = await this.fetchPaged<unknown>(`/repos/${this.encodePath(owner)}/${this.encodePath(repo)}/collaborators`, "GET");
    return data.map((item) => this.asCollaborator(item));
  }

  private async apiRequest<T>(path: string, method: string, body?: unknown, createSessionIfNone = true): Promise<T> {
    try {
      return await this.performRequest<T>(path, method, body, createSessionIfNone);
    } catch (error) {
      if (this.isUnauthorizedError(error)) {
        this.cachedSession = undefined;
        return this.performRequest<T>(path, method, body, createSessionIfNone);
      }
      throw error;
    }
  }

  private async performRequest<T>(path: string, method: string, body?: unknown, createSessionIfNone = true): Promise<T> {
    const token = await this.getAccessToken(createSessionIfNone);
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

  private async fetchPaged<T>(path: string, method: string): Promise<T[]> {
    const results: T[] = [];
    for (let page = 1; page <= 20; page += 1) {
      const separator = path.includes("?") ? "&" : "?";
      const pagedPath = `${path}${separator}per_page=100&page=${page}`;
      const data = await this.apiRequest<unknown>(pagedPath, method);
      if (!Array.isArray(data) || data.length === 0) {
        break;
      }
      results.push(...(data as T[]));
      if (data.length < 100) {
        break;
      }
    }
    return results;
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

  private asRepositorySummary(data: unknown): GitHubRepositorySummary {
    if (!this.isRecord(data)) {
      throw new Error("Unexpected GitHub repository response.");
    }
    const owner = this.isRecord(data.owner) && typeof data.owner.login === "string" ? data.owner.login : "";
    return {
      name: typeof data.name === "string" ? data.name : "",
      full_name: typeof data.full_name === "string" ? data.full_name : "",
      private: Boolean(data.private),
      default_branch: typeof data.default_branch === "string" ? data.default_branch : "main",
      description: typeof data.description === "string" || data.description === null ? data.description : undefined,
      topics: Array.isArray(data.topics) ? data.topics.filter((item): item is string => typeof item === "string") : [],
      html_url: typeof data.html_url === "string" ? data.html_url : undefined,
      owner
    };
  }

  private asRepositoryInvitation(data: unknown): GitHubRepositoryInvitation {
    if (!this.isRecord(data) || !this.isRecord(data.repository)) {
      throw new Error("Unexpected GitHub invitation response.");
    }
    return {
      id: typeof data.id === "number" ? data.id : Number(data.id),
      repository: this.asRepositorySummary(data.repository),
      inviter: this.isRecord(data.inviter) ? this.asUser(data.inviter) : undefined,
      invitee: this.isRecord(data.invitee) ? this.asUser(data.invitee) : undefined,
      permissions: typeof data.permissions === "string" ? data.permissions : undefined,
      created_at: typeof data.created_at === "string" ? data.created_at : undefined,
      html_url: typeof data.html_url === "string" ? data.html_url : undefined
    };
  }

  private asUser(data: JsonObject): GitHubUser {
    return {
      login: typeof data.login === "string" ? data.login : "",
      id: typeof data.id === "number" ? data.id : Number(data.id ?? 0),
      avatar_url: typeof data.avatar_url === "string" ? data.avatar_url : undefined
    };
  }

  private asCollaborator(data: unknown): GitHubRepositoryCollaborator {
    if (!this.isRecord(data)) {
      return { login: "", id: 0 };
    }
    return {
      login: typeof data.login === "string" ? data.login : "",
      id: typeof data.id === "number" ? data.id : Number(data.id ?? 0),
      avatar_url: typeof data.avatar_url === "string" ? data.avatar_url : undefined
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

  private async resolveSession(createIfNone: boolean): Promise<vscode.AuthenticationSession | undefined> {
    if (this.cachedSession) {
      return this.cachedSession;
    }

    if (this.sessionPromise) {
      return this.sessionPromise;
    }

    this.sessionPromise = this.loadSession(createIfNone).finally(() => {
      this.sessionPromise = undefined;
    });
    return this.sessionPromise;
  }

  private async loadSession(createIfNone: boolean): Promise<vscode.AuthenticationSession | undefined> {
    const account = await this.resolvePreferredAccount();
    try {
      if (account) {
        return await vscode.authentication.getSession(GITHUB_PROVIDER_ID, GITHUB_SCOPES, {
          account,
          createIfNone,
          silent: !createIfNone
        });
      }

      if (!createIfNone) {
        return await vscode.authentication.getSession(GITHUB_PROVIDER_ID, GITHUB_SCOPES, {
          silent: true
        });
      }

      return await vscode.authentication.getSession(GITHUB_PROVIDER_ID, GITHUB_SCOPES, {
        createIfNone: true
      });
    } catch (error) {
      if (!createIfNone) {
        return undefined;
      }
      throw this.asError(error, "GitHub authentication is not available.");
    }
  }

  private async resolvePreferredAccount(): Promise<vscode.AuthenticationSessionAccountInformation | undefined> {
    if (this.preferredAccount) {
      const accounts = await vscode.authentication.getAccounts(GITHUB_PROVIDER_ID);
      const match = accounts.find((account) => account.id === this.preferredAccount?.id);
      if (match) {
        this.preferredAccount = match;
        return match;
      }
    }

    const stored = this.context?.globalState.get<vscode.AuthenticationSessionAccountInformation | undefined>(PREFERRED_ACCOUNT_KEY);
    if (!stored) {
      return undefined;
    }
    const accounts = await vscode.authentication.getAccounts(GITHUB_PROVIDER_ID);
    const match = accounts.find((account) => account.id === stored.id);
    if (match) {
      this.preferredAccount = match;
      return match;
    }
    return undefined;
  }

  private async persistPreferredAccount(account: vscode.AuthenticationSessionAccountInformation): Promise<void> {
    this.preferredAccount = account;
    await this.context?.globalState.update(PREFERRED_ACCOUNT_KEY, { id: account.id, label: account.label });
  }

  private handleSessionChange(event: vscode.AuthenticationSessionsChangeEvent): void {
    if (event.provider.id !== GITHUB_PROVIDER_ID) {
      return;
    }

    this.cachedSession = undefined;
  }

  private isUnauthorizedError(error: unknown): boolean {
    return error instanceof Error && /401|unauthorized|bad credentials/i.test(error.message);
  }
}

export const githubService = GitHubService.getInstance();
