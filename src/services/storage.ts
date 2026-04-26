import * as vscode from "vscode";
import type { TodoGroup, TodoItem, TodoList, TodoStore } from "../extension";
import { githubService, type GitHubRepoTarget } from "./github";

const STORAGE_MODE_KEY = "todoListPro.storageMode";
const SHARED_LISTS_KEY = "todoListPro.sharedLists";
const CENTRAL_REPOSITORY_NAME = "TodoExtension";
const CENTRAL_REPOSITORY_BRANCH = "main";
const CENTRAL_LISTS_DIRECTORY = "lists";

export interface StorageProvider {
  listLists(): Promise<TodoList[]>;
  getList(listId: string): Promise<TodoList | null>;
  saveList(list: TodoList): Promise<void>;
  deleteList(listId: string): Promise<void>;
  sync(): Promise<void>;
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

type StorageMode = "local" | "github";

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
      completedAt: typeof todo.completedAt === "number" ? todo.completedAt : undefined
    }));
  }
}

export class GitHubRepoStorageProvider {
  public buildListPath(listId: string): string {
    return `${CENTRAL_LISTS_DIRECTORY}/${listId}.json`;
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
  ): Promise<{ sha: string }> {
    let resolvedSha = sha;
    if (!resolvedSha) {
      try {
        const current = await githubService.getRepoContents(target);
        resolvedSha = current.sha;
      } catch {
        resolvedSha = undefined;
      }
    }

    const remote = await githubService.putRepoContents(
      target,
      JSON.stringify(snapshot, null, 2),
      `Update ${snapshot.listName}`,
      resolvedSha
    );
    return { sha: remote.sha };
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

  private parseSnapshot(raw: string, target: GitHubRepoTarget): SharedListSnapshot {
    const parsed = JSON.parse(raw) as Partial<SharedListSnapshot>;
    if (parsed.schemaVersion !== 1) {
      throw new Error("Unsupported shared list schema version.");
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
    await this.ensureCentralRepository();
    await this.setStorageMode("github");
  }

  public async listLocalLists(): Promise<TodoList[]> {
    if (!this.localProvider) {
      throw new Error("Storage manager is not initialized.");
    }
    return this.localProvider.listLists();
  }

  public async shareLocalList(list: TodoList, target?: GitHubRepoTarget): Promise<SharedListRecord> {
    const resolvedTarget = target ?? (await this.buildCentralTargetForList(list.id));
    const snapshot = this.sharedProvider.snapshotFromList(list);
    const sha = await this.sharedProvider.saveSnapshot(resolvedTarget, snapshot);
    const existing = this.readSharedRecords().find((record) => record.listId === list.id);
    const record: SharedListRecord = {
      id: existing?.id ?? this.newId("shared"),
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
      id: this.newId("shared"),
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
      throw new Error("Shared list not found.");
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
      throw new Error("Shared list not found.");
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
        listId: nextList.id,
        listName: nextList.name,
        sha: saved.sha,
        lastSyncedAt: Date.now(),
        snapshot: nextList
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
    let sha = record.sha;
    if (!sha) {
      const current = await this.sharedProvider.loadSnapshot(record.target);
      sha = current.sha;
    }
    await this.sharedProvider.deleteSnapshot(record.target, sha);
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
    const { owner } = await githubService.ensureUserRepository(CENTRAL_REPOSITORY_NAME, {
      private: true,
      description: "Shared TODO lists for Projects TODO Advanced"
    });
    return { owner, repo: CENTRAL_REPOSITORY_NAME, branch: CENTRAL_REPOSITORY_BRANCH };
  }

  public async buildCentralTargetForList(listId: string): Promise<GitHubRepoTarget> {
    const base = await this.ensureCentralRepository();
    return {
      ...base,
      path: this.sharedProvider.buildListPath(listId)
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
    return {
      id: typeof record.id === "string" && record.id ? record.id : this.newId("shared"),
      listId: typeof record.listId === "string" && record.listId ? record.listId : this.newId("list"),
      listName: typeof record.listName === "string" && record.listName ? record.listName : "Shared List",
      provider: "github-repo",
      target: {
        owner: record.target.owner,
        repo: record.target.repo,
        branch: record.target.branch,
        path: record.target.path
      },
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
    return error instanceof Error ? error : new Error("Failed to save shared list.");
  }

  private newId(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

export const storageManager = StorageManager.getInstance();
