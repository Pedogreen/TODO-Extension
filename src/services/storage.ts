import * as vscode from "vscode";
import type { TodoGroup, TodoItem, TodoList, TodoStore } from "../extension";
import { githubService, type GitHubRepoTarget } from "./github";

const STORAGE_MODE_KEY = "todoListPro.storageMode";
const SHARED_LISTS_KEY = "todoListPro.sharedLists";
const PERSONAL_REPOSITORY_NAME = "todo-extension-personal";
const WORKSPACE_REPOSITORY_PREFIX = "todo-workspace-";
const MANAGED_REPOSITORY_DESCRIPTION_PREFIX = "Managed by TODO Extension";
const MANAGED_REPOSITORY_MARKER_PATH = ".todo-extension/manifest.json";
const REPOSITORY_LISTS_DIRECTORY = "lists";

export interface StorageProvider {
  listLists(): Promise<TodoList[]>;
  getList(listId: string): Promise<TodoList | null>;
  saveList(list: TodoList): Promise<void>;
  deleteList(listId: string): Promise<void>;
  sync(): Promise<void>;
}

export interface ManagedRepositoryRecord {
  kind: "personal" | "workspace";
  name: string;
  description?: string;
  collaborators?: string[];
  target: GitHubRepoTarget;
}

export interface ManagedRepositoryManifest {
  version: 1;
  kind: "personal" | "workspace";
  name: string;
  createdAt: string;
}

export interface SharedListSnapshot extends TodoList {
  schemaVersion: number;
  updatedAt: string;
  extensionName: string;
  listId: string;
  listName: string;
  workspaceVisibility?: string[];
}

export interface ShareKeyPayload {
  type: "projects-todo-share";
  version: 1;
  provider: "github-repo";
  repo: string;
  branch: string;
  path: string;
  listId: string;
  listName: string;
}

export interface SharedListRecord {
  id: string;
  listId: string;
  listName: string;
  provider: "github-repo";
  target: GitHubRepoTarget;
  sha?: string;
  lastSyncedAt?: number;
  snapshot: TodoList;
}

interface SharedListsState {
  records: SharedListRecord[];
}

type StorageMode = "local" | "hybrid" | "github";

export class LocalStorageProvider implements StorageProvider {
  private static readonly LISTS_KEY = "todoListPro.lists";

  public constructor(private readonly context: vscode.ExtensionContext) {}

  public async listLists(): Promise<TodoList[]> {
    const raw = this.context.globalState.get<TodoList[] | undefined>(LocalStorageProvider.LISTS_KEY) ?? [];
    return raw.map((list, index) => this.normalizeList(list, index));
  }

  public async getList(listId: string): Promise<TodoList | null> {
    const lists = await this.listLists();
    return lists.find((list) => list.id === listId) ?? null;
  }

  public async saveList(list: TodoList): Promise<void> {
    const lists = await this.listLists();
    const index = lists.findIndex((item) => item.id === list.id);
    const next = { ...list, store: this.normalizeStore(list.store) };

    if (index >= 0) {
      lists[index] = next;
    } else {
      lists.push(next);
    }

    await this.context.globalState.update(LocalStorageProvider.LISTS_KEY, lists);
  }

  public async deleteList(listId: string): Promise<void> {
    const lists = await this.listLists();
    await this.context.globalState.update(
      LocalStorageProvider.LISTS_KEY,
      lists.filter((list) => list.id !== listId)
    );
  }

  public async sync(): Promise<void> {
    // Local mode is self-contained.
  }

  private normalizeList(list: Partial<TodoList>, index: number): TodoList {
    return {
      id: typeof list.id === "string" && list.id ? list.id : `list-${Date.now()}-${index}`,
      name: typeof list.name === "string" && list.name.trim() ? list.name.trim() : `List ${index + 1}`,
      createdAt: typeof list.createdAt === "number" ? list.createdAt : Date.now(),
      store: this.normalizeStore(list.store)
    };
  }

  private normalizeStore(store?: Partial<TodoStore>): TodoStore {
    return {
      groups: this.normalizeGroups(store?.groups ?? []),
      todos: this.normalizeTodos(store?.todos ?? [])
    };
  }

  private normalizeGroups(groups: TodoGroup[]): TodoGroup[] {
    return (groups ?? []).map((group, index) => ({
      id: typeof group.id === "string" && group.id ? group.id : `group-${Date.now()}-${index}`,
      name: typeof group.name === "string" && group.name.trim() ? group.name.trim() : "Untitled group",
      groups: this.normalizeGroups(group.groups ?? []),
      todos: this.normalizeTodos(group.todos ?? [])
    }));
  }

  private normalizeTodos(todos: TodoItem[]): TodoItem[] {
    return (todos ?? []).map((todo, index) => ({
      id: typeof todo.id === "string" && todo.id ? todo.id : `todo-${Date.now()}-${index}`,
      text: typeof todo.text === "string" ? todo.text : "",
      done: Boolean(todo.done),
      createdAt: typeof todo.createdAt === "number" ? todo.createdAt : Date.now(),
      author: typeof todo.author === "string" && todo.author.trim() ? todo.author.trim() : undefined,
      completedAt: typeof todo.completedAt === "number" ? todo.completedAt : undefined
    }));
  }
}

export class GitHubRepoStorageProvider {
  public buildListPath(listId: string): string {
    return `${REPOSITORY_LISTS_DIRECTORY}/${listId}.json`;
  }

  public async loadFromShareKey(shareKey: string): Promise<{ target: GitHubRepoTarget; listId: string; listName: string }> {
    const payload = this.decodeShareKey(shareKey);
    return {
      target: {
        owner: this.parseRepoOwner(payload.repo),
        repo: this.parseRepoName(payload.repo),
        branch: payload.branch,
        path: payload.path
      },
      listId: payload.listId,
      listName: payload.listName
    };
  }

  public createShareKey(target: GitHubRepoTarget, listId: string, listName: string): string {
    const payload: ShareKeyPayload = {
      type: "projects-todo-share",
      version: 1,
      provider: "github-repo",
      repo: `${target.owner}/${target.repo}`,
      branch: target.branch,
      path: target.path,
      listId,
      listName
    };
    return `todo-share://${this.encodePayload(payload)}`;
  }

  public snapshotFromList(list: TodoList, updatedAt = new Date().toISOString()): SharedListSnapshot {
    return {
      schemaVersion: 1,
      updatedAt,
      extensionName: "Projects TODO Advanced",
      listId: list.id,
      listName: list.name,
      createdAt: list.createdAt,
      id: list.id,
      name: list.name,
      store: this.normalizeStore(list.store)
    };
  }

  public listFromSnapshot(snapshot: SharedListSnapshot): TodoList {
    return {
      id: snapshot.listId,
      name: snapshot.listName,
      createdAt: snapshot.createdAt,
      store: this.normalizeStore(snapshot.store)
    };
  }

  public async loadSnapshot(target: GitHubRepoTarget): Promise<{ snapshot: SharedListSnapshot; sha: string }> {
    const content = await githubService.getRepoContents(target);
    const snapshot = this.parseSnapshot(content.content, target);
    return { snapshot, sha: content.sha };
  }

  public async saveSnapshot(
    target: GitHubRepoTarget,
    snapshot: SharedListSnapshot,
    sha?: string
  ): Promise<{ sha: string; snapshot: SharedListSnapshot }> {
    let resolvedSha = sha;
    if (!resolvedSha) {
      try {
        const current = await githubService.getRepoContents(target);
        resolvedSha = current.sha;
      } catch {
        resolvedSha = undefined;
      }
    }

    try {
      const remote = await githubService.putRepoContents(
        target,
        JSON.stringify(snapshot, null, 2),
        `Update ${snapshot.listName}`,
        resolvedSha
      );
      return { sha: remote.sha, snapshot };
    } catch (error) {
      if (!this.isConflictError(error)) {
        throw error;
      }

      const current = await this.loadSnapshot(target);
      const merged = this.mergeSnapshots(current.snapshot, snapshot);
      const remote = await githubService.putRepoContents(
        target,
        JSON.stringify(merged, null, 2),
        `Update ${merged.listName}`,
        current.sha
      );
      return { sha: remote.sha, snapshot: merged };
    }
  }

  public async deleteSnapshot(target: GitHubRepoTarget, sha: string): Promise<void> {
    await githubService.deleteRepoContents(target, `Delete ${target.path}`, sha);
  }

  public encodeShareKey(payload: ShareKeyPayload): string {
    return `todo-share://${this.encodePayload(payload)}`;
  }

  public decodeShareKey(shareKey: string): ShareKeyPayload {
    const raw = shareKey.startsWith("todo-share://") ? shareKey.slice("todo-share://".length) : shareKey;
    const json = Buffer.from(raw, "base64").toString("utf8");
    const parsed = JSON.parse(json) as Partial<ShareKeyPayload>;
    if (!parsed || parsed.type !== "projects-todo-share" || parsed.version !== 1 || parsed.provider !== "github-repo") {
      throw new Error("Invalid share key.");
    }
    if (!parsed.repo || !parsed.branch || !parsed.path || !parsed.listId || !parsed.listName) {
      throw new Error("Share key is missing required data.");
    }
    return parsed as ShareKeyPayload;
  }

  public buildTarget(owner: string, repo: string, branch: string, path: string): GitHubRepoTarget {
    return { owner, repo, branch, path };
  }

  private parseRepoOwner(repo: string): string {
    const [owner] = repo.split("/");
    if (!owner) {
      throw new Error("Invalid repo value.");
    }
    return owner;
  }

  private parseRepoName(repo: string): string {
    const [, name] = repo.split("/");
    if (!name) {
      throw new Error("Invalid repo value.");
    }
    return name;
  }

  private encodePayload(payload: ShareKeyPayload): string {
    return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  }

  private isConflictError(error: unknown): boolean {
    return error instanceof Error && /sha|conflict|precondition|changed/i.test(error.message);
  }

  private mergeSnapshots(remote: SharedListSnapshot, local: SharedListSnapshot): SharedListSnapshot {
    return {
      schemaVersion: 1,
      updatedAt: local.updatedAt,
      extensionName: local.extensionName || remote.extensionName || "Projects TODO Advanced",
      listId: local.listId || remote.listId,
      listName: local.listName || remote.listName,
      createdAt: local.createdAt || remote.createdAt,
      id: local.id || remote.id,
      name: local.name || remote.name,
      store: this.mergeStores(remote.store, local.store)
    };
  }

  private mergeStores(remote: TodoStore, local: TodoStore): TodoStore {
    return {
      todos: this.mergeTodos(remote.todos, local.todos),
      groups: this.mergeGroups(remote.groups, local.groups)
    };
  }

  private mergeGroups(remoteGroups: TodoGroup[], localGroups: TodoGroup[]): TodoGroup[] {
    const merged = new Map<string, TodoGroup>();
    for (const group of remoteGroups) {
      merged.set(group.id, this.cloneGroup(group));
    }
    for (const group of localGroups) {
      const current = merged.get(group.id);
      if (!current) {
        merged.set(group.id, this.cloneGroup(group));
        continue;
      }
      merged.set(group.id, this.mergeGroup(current, group));
    }
    return [...merged.values()];
  }

  private mergeGroup(remote: TodoGroup, local: TodoGroup): TodoGroup {
    return {
      id: local.id || remote.id,
      name: local.name || remote.name,
      groups: this.mergeGroups(remote.groups ?? [], local.groups ?? []),
      todos: this.mergeTodos(remote.todos ?? [], local.todos ?? [])
    };
  }

  private mergeTodos(remoteTodos: TodoItem[], localTodos: TodoItem[]): TodoItem[] {
    const merged = new Map<string, TodoItem>();
    for (const todo of remoteTodos) {
      merged.set(todo.id, { ...todo });
    }
    for (const todo of localTodos) {
      const current = merged.get(todo.id);
      if (!current) {
        merged.set(todo.id, { ...todo });
        continue;
      }
      merged.set(todo.id, { ...current, ...todo });
    }
    return [...merged.values()];
  }

  private cloneGroup(group: TodoGroup): TodoGroup {
    return {
      id: group.id,
      name: group.name,
      groups: group.groups ? this.mergeGroups([], group.groups) : [],
      todos: group.todos ? this.mergeTodos([], group.todos) : []
    };
  }

  private parseSnapshot(raw: string, target: GitHubRepoTarget): SharedListSnapshot {
    const parsed = JSON.parse(raw) as Partial<SharedListSnapshot>;
    if (parsed.schemaVersion !== 1) {
      throw new Error("Unsupported workspace list schema version.");
    }
    if (parsed.listId !== parsed.id || parsed.listName !== parsed.name) {
      // tolerate older/wider payloads by normalizing below
    }
    return {
      schemaVersion: 1,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
      extensionName: typeof parsed.extensionName === "string" ? parsed.extensionName : "Projects TODO Advanced",
      listId: typeof parsed.listId === "string" ? parsed.listId : target.path,
      listName: typeof parsed.listName === "string" ? parsed.listName : target.path.split("/").pop() ?? "Shared List",
      createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : Date.now(),
      id: typeof parsed.id === "string" ? parsed.id : target.path,
      name: typeof parsed.name === "string" ? parsed.name : target.path.split("/").pop() ?? "Shared List",
      store: this.normalizeStore(parsed.store)
    };
  }

  private normalizeStore(store?: Partial<TodoStore>): TodoStore {
    return {
      groups: this.normalizeGroups(store?.groups ?? []),
      todos: this.normalizeTodos(store?.todos ?? [])
    };
  }

  private normalizeGroups(groups: TodoGroup[]): TodoGroup[] {
    return (groups ?? []).map((group, index) => ({
      id: typeof group.id === "string" && group.id ? group.id : `group-${Date.now()}-${index}`,
      name: typeof group.name === "string" && group.name.trim() ? group.name.trim() : "Untitled group",
      groups: this.normalizeGroups(group.groups ?? []),
      todos: this.normalizeTodos(group.todos ?? [])
    }));
  }

  private normalizeTodos(todos: TodoItem[]): TodoItem[] {
    return (todos ?? []).map((todo, index) => ({
      id: typeof todo.id === "string" && todo.id ? todo.id : `todo-${Date.now()}-${index}`,
      text: typeof todo.text === "string" ? todo.text : "",
      done: Boolean(todo.done),
      createdAt: typeof todo.createdAt === "number" ? todo.createdAt : Date.now(),
      author: typeof todo.author === "string" && todo.author.trim() ? todo.author.trim() : undefined,
      completedAt: typeof todo.completedAt === "number" ? todo.completedAt : undefined
    }));
  }
}

export class StorageManager {
  private static instance: StorageManager;
  private context: vscode.ExtensionContext | null = null;
  private currentMode: StorageMode = "local";
  private localProvider: LocalStorageProvider | null = null;
  private sharedProvider = new GitHubRepoStorageProvider();
  private personalRepository?: ManagedRepositoryRecord;

  private readonly sharedListsKey = SHARED_LISTS_KEY;

  public static getInstance(): StorageManager {
    if (!StorageManager.instance) {
      StorageManager.instance = new StorageManager();
    }
    return StorageManager.instance;
  }

  public initialize(context: vscode.ExtensionContext): void {
    this.context = context;
    this.localProvider = new LocalStorageProvider(context);
    this.currentMode = context.workspaceState.get<StorageMode>(STORAGE_MODE_KEY) ?? "local";
  }

  public getStorageMode(): StorageMode {
    return this.currentMode;
  }

  public async setStorageMode(mode: StorageMode): Promise<void> {
    this.currentMode = mode;
    if (this.context) {
      await this.context.workspaceState.update(STORAGE_MODE_KEY, mode);
    }
  }

  public async switchToLocal(): Promise<void> {
    await this.setStorageMode("local");
  }

  public async switchToShare(): Promise<void> {
    await this.switchToGitHubFull();
  }

  public async switchToHybrid(): Promise<void> {
    await this.setStorageMode("hybrid");
  }

  public async switchToGitHubFull(): Promise<vscode.Uri> {
    const localLists = await this.listLocalLists();
    const backup = await this.createLocalBackup(localLists);
    const personal = await this.ensurePersonalRepository();
    for (const list of localLists) {
      await this.saveRepositoryList(personal, list);
    }
    for (const list of localLists) {
      await this.localProvider?.deleteList(list.id);
    }
    await this.setStorageMode("github");
    return backup;
  }

  public async listLocalLists(): Promise<TodoList[]> {
    if (!this.localProvider) {
      throw new Error("Storage manager is not initialized.");
    }
    return this.localProvider.listLists();
  }

  public async createLocalBackup(lists: TodoList[]): Promise<vscode.Uri> {
    if (!this.context) {
      throw new Error("Storage manager is not initialized.");
    }

    const backupsDir = vscode.Uri.joinPath(this.context.globalStorageUri, "backups");
    await vscode.workspace.fs.createDirectory(backupsDir);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupUri = vscode.Uri.joinPath(backupsDir, `todo-backup-${stamp}.json`);
    const payload = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      storageMode: this.currentMode,
      lists
    };
    await vscode.workspace.fs.writeFile(backupUri, Buffer.from(JSON.stringify(payload, null, 2), "utf8"));
    return backupUri;
  }

  public async ensurePersonalRepository(): Promise<ManagedRepositoryRecord> {
    if (this.personalRepository) {
      return this.personalRepository;
    }

    const repo = await githubService.ensureUserRepository(PERSONAL_REPOSITORY_NAME, {
      private: true,
      description: `${MANAGED_REPOSITORY_DESCRIPTION_PREFIX} personal repository`
    });
    const target: GitHubRepoTarget = {
      owner: repo.owner,
      repo: repo.repo.name,
      branch: repo.repo.default_branch || "main",
      path: ""
    };
    await this.writeManagedRepositoryMarker(target, {
      version: 1,
      kind: "personal",
      name: PERSONAL_REPOSITORY_NAME,
      createdAt: new Date().toISOString()
    });
    this.personalRepository = {
      kind: "personal",
      name: PERSONAL_REPOSITORY_NAME,
      description: `${MANAGED_REPOSITORY_DESCRIPTION_PREFIX} personal repository`,
      collaborators: [],
      target
    };
    return this.personalRepository;
  }

  public async ensureWorkspaceRepository(workspaceName: string): Promise<ManagedRepositoryRecord> {
    const slug = this.slugify(workspaceName);
    const repoName = `${WORKSPACE_REPOSITORY_PREFIX}${slug}`;
    const repo = await githubService.ensureUserRepository(repoName, {
      private: true,
      description: `${MANAGED_REPOSITORY_DESCRIPTION_PREFIX} workspace ${workspaceName}`
    });
    const target: GitHubRepoTarget = {
      owner: repo.owner,
      repo: repo.repo.name,
      branch: repo.repo.default_branch || "main",
      path: ""
    };
    await this.writeManagedRepositoryMarker(target, {
      version: 1,
      kind: "workspace",
      name: workspaceName,
      createdAt: new Date().toISOString()
    });
    return {
      kind: "workspace",
      name: workspaceName,
      description: `${MANAGED_REPOSITORY_DESCRIPTION_PREFIX} workspace ${workspaceName}`,
      collaborators: [],
      target
    };
  }

  public async listPersonalLists(): Promise<SharedListRecord[]> {
    return this.listRepositoryLists(await this.ensurePersonalRepository());
  }

  public async savePersonalList(list: TodoList): Promise<SharedListRecord> {
    return this.saveRepositoryList(await this.ensurePersonalRepository(), list);
  }

  public async deletePersonalList(listId: string): Promise<void> {
    await this.deleteRepositoryList(await this.ensurePersonalRepository(), listId);
  }

  public async deletePersonalListIfExists(listId: string): Promise<void> {
    const personal = await this.findPersonalRepository();
    if (!personal) {
      return;
    }
    await this.deleteRepositoryList(personal, listId);
  }

  public async discoverManagedRepositories(): Promise<ManagedRepositoryRecord[]> {
    const repos = await githubService.listCurrentUserRepositories();
    const managed: ManagedRepositoryRecord[] = [];
    for (const repo of repos) {
      const isManaged =
        repo.name === PERSONAL_REPOSITORY_NAME ||
        repo.name.startsWith(WORKSPACE_REPOSITORY_PREFIX) ||
        Boolean(repo.topics.includes("todo-extension")) ||
        Boolean(repo.description?.includes(MANAGED_REPOSITORY_DESCRIPTION_PREFIX));
      if (!isManaged) {
        continue;
      }

      const target: GitHubRepoTarget = {
        owner: repo.owner,
        repo: repo.name,
        branch: repo.default_branch || "main",
        path: ""
      };
      const manifest = await this.readManagedRepositoryMarker(target).catch(() => undefined);
      const collaborators = await this.listRepositoryCollaborators(target).catch(() => []);
      managed.push({
        kind: manifest?.kind ?? (repo.name === PERSONAL_REPOSITORY_NAME ? "personal" : "workspace"),
        name: manifest?.name ?? repo.name,
        description: repo.description ?? undefined,
        collaborators,
        target
      });
    }
    return managed;
  }

  public async listWorkspaceRepositories(): Promise<ManagedRepositoryRecord[]> {
    return (await this.discoverManagedRepositories()).filter((repo) => repo.kind === "workspace");
  }

  public async findPersonalRepository(): Promise<ManagedRepositoryRecord | undefined> {
    if (this.personalRepository) {
      return this.personalRepository;
    }

    const repositories = await this.discoverManagedRepositories();
    const personal = repositories.find((repo) => repo.kind === "personal");
    if (!personal) {
      return undefined;
    }

    this.personalRepository = personal;
    return personal;
  }

  public async listWorkspaceLists(): Promise<SharedListRecord[]> {
    const repos = await this.listWorkspaceRepositories();
    const lists: SharedListRecord[] = [];
    for (const repo of repos) {
      lists.push(...(await this.listRepositoryLists(repo)));
    }
    return lists;
  }

  public async listRepositoryLists(repository: ManagedRepositoryRecord): Promise<SharedListRecord[]> {
    const files = await githubService.listRepositoryFiles(repository.target, REPOSITORY_LISTS_DIRECTORY);
    const jsonFiles = files.filter((file) => file.type === "file" && file.name.toLowerCase().endsWith(".json"));
    const records: SharedListRecord[] = [];
    for (const file of jsonFiles) {
      const target = { ...repository.target, path: file.path };
      const { snapshot, sha } = await this.sharedProvider.loadSnapshot(target);
      records.push({
        id: this.buildSharedRecordId(target),
        listId: snapshot.listId,
        listName: snapshot.listName,
        provider: "github-repo",
        target,
        sha,
        lastSyncedAt: Date.now(),
        snapshot: this.sharedProvider.listFromSnapshot(snapshot)
      });
    }
    return records;
  }

  public async saveRepositoryList(repository: ManagedRepositoryRecord, list: TodoList): Promise<SharedListRecord> {
    return this.saveRepositorySnapshot(repository, list);
  }

  public async saveRepositorySnapshot(
    repository: ManagedRepositoryRecord,
    list: TodoList,
    sha?: string
  ): Promise<SharedListRecord> {
    const target = { ...repository.target, path: `${REPOSITORY_LISTS_DIRECTORY}/${list.id}.json` };
    const snapshot = this.sharedProvider.snapshotFromList(list);
    const saved = await this.sharedProvider.saveSnapshot(target, snapshot, sha);
    return {
      id: this.buildSharedRecordId(target),
      listId: saved.snapshot.listId,
      listName: saved.snapshot.listName,
      provider: "github-repo",
      target,
      sha: saved.sha,
      lastSyncedAt: Date.now(),
      snapshot: this.sharedProvider.listFromSnapshot(saved.snapshot)
    };
  }

  public async deleteRepositoryList(repository: ManagedRepositoryRecord, listId: string): Promise<void> {
    const target = { ...repository.target, path: `${REPOSITORY_LISTS_DIRECTORY}/${listId}.json` };
    const content = await githubService.getRepoContents(target);
    await githubService.deleteRepoContents(target, `Delete ${listId}`, content.sha);
  }

  public async inviteCollaborator(repository: ManagedRepositoryRecord, username: string): Promise<void> {
    await githubService.inviteCollaborator(repository.target.owner, repository.target.repo, username, "push");
  }

  public async listPendingInvitations(repository: ManagedRepositoryRecord): Promise<import("./github").GitHubRepositoryInvitation[]> {
    return githubService.listRepositoryInvitations(repository.target.owner, repository.target.repo);
  }

  public async listCurrentUserInvitations(): Promise<import("./github").GitHubRepositoryInvitation[]> {
    return githubService.listCurrentUserRepositoryInvitations();
  }

  public async acceptInvitation(invitationId: number): Promise<void> {
    await githubService.acceptRepositoryInvitation(invitationId);
  }

  public async declineInvitation(invitationId: number): Promise<void> {
    await githubService.declineRepositoryInvitation(invitationId);
  }

  public async shareLocalList(list: TodoList, target?: GitHubRepoTarget): Promise<SharedListRecord> {
    const resolvedTarget = target ?? (await this.buildCentralTargetForList(list.id));
    const snapshot = this.sharedProvider.snapshotFromList(list);
    const sha = await this.sharedProvider.saveSnapshot(resolvedTarget, snapshot);
    const existing = this.readSharedRecords().find((record) => record.listId === list.id);
    const record: SharedListRecord = {
      id: existing?.id ?? this.buildSharedRecordId(resolvedTarget),
      listId: list.id,
      listName: list.name,
      provider: "github-repo",
      target: resolvedTarget,
      sha: sha.sha,
      lastSyncedAt: Date.now(),
      snapshot: this.sharedProvider.listFromSnapshot(snapshot)
    };
    await this.upsertSharedRecord(record);
    return record;
  }

  public async addSharedListFromShareKey(shareKey: string): Promise<SharedListRecord> {
    const decoded = this.sharedProvider.decodeShareKey(shareKey);
    const [owner, repo] = decoded.repo.split("/");
    if (!owner || !repo) {
      throw new Error("Invalid repo in share key.");
    }
    const target = this.sharedProvider.buildTarget(owner, repo, decoded.branch, decoded.path);
    const { snapshot, sha } = await this.sharedProvider.loadSnapshot(target);
    const record: SharedListRecord = {
      id: this.buildSharedRecordId(target),
      listId: snapshot.listId,
      listName: snapshot.listName,
      provider: "github-repo",
      target,
      sha,
      lastSyncedAt: Date.now(),
      snapshot: this.sharedProvider.listFromSnapshot(snapshot)
    };
    await this.upsertSharedRecord(record);
    return record;
  }

  public async syncSharedList(recordId: string): Promise<SharedListRecord> {
    const record = await this.getSharedRecord(recordId);
    if (!record) {
      throw new Error("Workspace list not found.");
    }
    const { snapshot, sha } = await this.sharedProvider.loadSnapshot(record.target);
    const next: SharedListRecord = {
      ...record,
      listId: snapshot.listId,
      listName: snapshot.listName,
      sha,
      lastSyncedAt: Date.now(),
      snapshot: this.sharedProvider.listFromSnapshot(snapshot)
    };
    await this.upsertSharedRecord(next);
    return next;
  }

  public async saveSharedList(recordId: string, updater: (list: TodoList) => void): Promise<SharedListRecord> {
    const record = await this.getSharedRecord(recordId);
    if (!record) {
      throw new Error("Workspace list not found.");
    }

    const nextList: TodoList = {
      ...record.snapshot,
      store: this.cloneStore(record.snapshot.store)
    };
    updater(nextList);
    nextList.store = this.normalizeStore(nextList.store);
    const snapshot = this.sharedProvider.snapshotFromList(nextList);
    try {
      const saved = await this.sharedProvider.saveSnapshot(record.target, snapshot, record.sha);
      const next: SharedListRecord = {
        ...record,
        listId: saved.snapshot.listId,
        listName: saved.snapshot.listName,
        sha: saved.sha,
        lastSyncedAt: Date.now(),
        snapshot: this.sharedProvider.listFromSnapshot(saved.snapshot)
      };
      await this.upsertSharedRecord(next);
      return next;
    } catch (error) {
      throw this.normalizeConflictError(error);
    }
  }

  public async deleteSharedList(recordId: string): Promise<void> {
    const record = await this.getSharedRecord(recordId);
    if (!record) {
      return;
    }
    await this.removeSharedRecord(recordId);
    // Do not delete remote content automatically. Safe default.
  }

  public async deleteRemoteSharedList(recordId: string): Promise<void> {
    const record = await this.getSharedRecord(recordId);
    if (!record) {
      return;
    }
    let currentSha = record.sha;
    if (!currentSha) {
      const current = await this.sharedProvider.loadSnapshot(record.target);
      currentSha = current.sha;
    }
    try {
      await this.sharedProvider.deleteSnapshot(record.target, currentSha);
    } catch (error) {
      if (!(error instanceof Error) || !/sha|conflict|precondition|changed/i.test(error.message)) {
        throw error;
      }

      const refreshed = await this.sharedProvider.loadSnapshot(record.target);
      await this.sharedProvider.deleteSnapshot(record.target, refreshed.sha);
    }
    await this.removeSharedRecord(recordId);
  }

  public async listSharedLists(): Promise<SharedListRecord[]> {
    return this.readSharedRecords();
  }

  public async getSharedRecord(recordId: string): Promise<SharedListRecord | undefined> {
    return this.readSharedRecords().find((record) => record.id === recordId);
  }

  public createShareKey(target: GitHubRepoTarget, listId: string, listName: string): string {
    return this.sharedProvider.encodeShareKey({
      type: "projects-todo-share",
      version: 1,
      provider: "github-repo",
      repo: `${target.owner}/${target.repo}`,
      branch: target.branch,
      path: target.path,
      listId,
      listName
    });
  }

  public async copyLocalListToShareMode(list: TodoList, target?: GitHubRepoTarget): Promise<SharedListRecord> {
    return this.shareLocalList(list, target);
  }

  public async sync(): Promise<void> {
    const records = await this.listSharedLists();
    for (const record of records) {
      try {
        await this.syncSharedList(record.id);
      } catch {
        // Keep stale local snapshot on sync errors.
      }
    }
  }

  public getSharedProvider(): GitHubRepoStorageProvider {
    return this.sharedProvider;
  }

  public async ensureCentralRepository(): Promise<{ owner: string; repo: string; branch: string }> {
    const personal = await this.ensurePersonalRepository();
    return { owner: personal.target.owner, repo: personal.target.repo, branch: personal.target.branch };
  }

  public async buildCentralTargetForList(listId: string): Promise<GitHubRepoTarget> {
    const base = await this.ensurePersonalRepository();
    return {
      owner: base.target.owner,
      repo: base.target.repo,
      branch: base.target.branch,
      path: `${REPOSITORY_LISTS_DIRECTORY}/${listId}.json`
    };
  }

  private async upsertSharedRecord(record: SharedListRecord): Promise<void> {
    const state = this.readSharedState();
    const filtered = state.records.filter((item) => item.id !== record.id);
    filtered.push(record);
    await this.context?.workspaceState.update(this.sharedListsKey, { records: filtered } satisfies SharedListsState);
  }

  private async removeSharedRecord(recordId: string): Promise<void> {
    const state = this.readSharedState();
    await this.context?.workspaceState.update(this.sharedListsKey, {
      records: state.records.filter((item) => item.id !== recordId)
    } satisfies SharedListsState);
  }

  private readSharedState(): SharedListsState {
    return this.context?.workspaceState.get<SharedListsState>(this.sharedListsKey) ?? { records: [] };
  }

  private readSharedRecords(): SharedListRecord[] {
    return this.readSharedState().records.map((record) => this.normalizeSharedRecord(record));
  }

  private normalizeSharedRecord(record: SharedListRecord): SharedListRecord {
    const target = {
      owner: record.target.owner,
      repo: record.target.repo,
      branch: record.target.branch,
      path: record.target.path
    };
    return {
      id: typeof record.id === "string" && record.id ? record.id : this.buildSharedRecordId(target),
      listId: typeof record.listId === "string" && record.listId ? record.listId : this.newId("list"),
      listName: typeof record.listName === "string" && record.listName ? record.listName : "Shared List",
      provider: "github-repo",
      target,
      sha: typeof record.sha === "string" && record.sha ? record.sha : undefined,
      lastSyncedAt: typeof record.lastSyncedAt === "number" ? record.lastSyncedAt : undefined,
      snapshot: this.normalizeList(record.snapshot)
    };
  }

  private normalizeList(list: TodoList): TodoList {
    return {
      id: typeof list.id === "string" && list.id ? list.id : this.newId("list"),
      name: typeof list.name === "string" && list.name ? list.name : "List",
      createdAt: typeof list.createdAt === "number" ? list.createdAt : Date.now(),
      store: this.normalizeStore(list.store)
    };
  }

  private normalizeStore(store?: Partial<TodoStore>): TodoStore {
    return {
      groups: this.normalizeGroups(store?.groups ?? []),
      todos: this.normalizeTodos(store?.todos ?? [])
    };
  }

  private normalizeGroups(groups: TodoGroup[]): TodoGroup[] {
    return (groups ?? []).map((group, index) => ({
      id: typeof group.id === "string" && group.id ? group.id : this.newId(`group-${index}`),
      name: typeof group.name === "string" && group.name.trim() ? group.name.trim() : "Untitled group",
      groups: this.normalizeGroups(group.groups ?? []),
      todos: this.normalizeTodos(group.todos ?? [])
    }));
  }

  private normalizeTodos(todos: TodoItem[]): TodoItem[] {
    return (todos ?? []).map((todo, index) => ({
      id: typeof todo.id === "string" && todo.id ? todo.id : this.newId(`todo-${index}`),
      text: typeof todo.text === "string" ? todo.text : "",
      done: Boolean(todo.done),
      createdAt: typeof todo.createdAt === "number" ? todo.createdAt : Date.now(),
      author: typeof todo.author === "string" && todo.author.trim() ? todo.author.trim() : undefined,
      completedAt: typeof todo.completedAt === "number" ? todo.completedAt : undefined
    }));
  }

  private cloneStore(store: TodoStore): TodoStore {
    return JSON.parse(JSON.stringify(store)) as TodoStore;
  }

  private normalizeConflictError(error: unknown): Error {
    if (error instanceof Error && /sha|conflict|precondition|changed/i.test(error.message)) {
      return new Error("Remote list was changed by someone else. Please refresh before saving.");
    }
    return error instanceof Error ? error : new Error("Failed to save workspace list.");
  }

  private async writeManagedRepositoryMarker(target: GitHubRepoTarget, manifest: ManagedRepositoryManifest): Promise<void> {
    await githubService.putRepoContents(
      { ...target, path: MANAGED_REPOSITORY_MARKER_PATH },
      JSON.stringify(manifest, null, 2),
      `Update repository marker for ${manifest.name}`
    );
    await githubService.setRepositoryTopicAndDescription(target.owner, target.repo, {
      description: `${MANAGED_REPOSITORY_DESCRIPTION_PREFIX} ${manifest.kind} ${manifest.name}`,
      topics: ["todo-extension"]
    });
  }

  private async listRepositoryCollaborators(target: GitHubRepoTarget): Promise<string[]> {
    const collaborators = await githubService.listRepositoryCollaborators(target.owner, target.repo);
    return collaborators.map((item) => item.login).filter((login) => typeof login === "string" && login.length > 0);
  }

  private async readManagedRepositoryMarker(target: GitHubRepoTarget): Promise<ManagedRepositoryManifest | undefined> {
    try {
      const content = await githubService.getRepoContents({ ...target, path: MANAGED_REPOSITORY_MARKER_PATH });
      const parsed = JSON.parse(content.content) as Partial<ManagedRepositoryManifest>;
      if (parsed.version !== 1 || (parsed.kind !== "personal" && parsed.kind !== "workspace")) {
        return undefined;
      }
      return {
        version: 1,
        kind: parsed.kind,
        name: typeof parsed.name === "string" ? parsed.name : target.repo,
        createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date().toISOString()
      };
    } catch {
      return undefined;
    }
  }

  private slugify(value: string): string {
    return value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/-{2,}/g, "-")
      .slice(0, 48) || "workspace";
  }

  private buildSharedRecordId(target: GitHubRepoTarget): string {
    return `shared:${Buffer.from(`${target.owner}/${target.repo}/${target.branch}/${target.path}`, "utf8").toString("base64url")}`;
  }

  private newId(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

export const storageManager = StorageManager.getInstance();
