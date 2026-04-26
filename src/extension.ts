import * as vscode from "vscode";
import { storageManager, type SharedListRecord } from "./services/storage";

type ListId = string;
type GroupId = string;
type TodoId = string;
type ListSource = "local" | "shared";

export interface TodoItem {
  id: TodoId;
  text: string;
  done: boolean;
  createdAt: number;
  completedAt?: number;
}

export interface TodoGroup {
  id: GroupId;
  name: string;
  groups: TodoGroup[];
  todos: TodoItem[];
}

export interface TodoStore {
  groups: TodoGroup[];
  todos: TodoItem[];
}

export interface TodoList {
  id: ListId;
  name: string;
  createdAt: number;
  store: TodoStore;
}

export interface ShellState {
  lists: boolean;
}

interface LegacyTodoStore {
  groups?: TodoGroup[];
  todos?: TodoItem[];
}

interface LegacySharedScope {
  id: string;
  name: string;
  createdAt: number;
}

interface LegacyScopeRegistry {
  scopes?: LegacySharedScope[];
  stores?: Record<string, LegacyTodoStore | undefined>;
}

interface ExportPayload {
  version: 2;
  exportedAt: string;
  entries: Array<{ list: TodoList }>;
}

type WebviewAction =
  | { type: "setFilter"; value: string }
  | { type: "clearFilter" }
  | { type: "toggleShellSection"; shellId: keyof ShellState }
  | { type: "toggleListExpanded"; listId: ListId; source?: ListSource }
  | { type: "addList" }
  | { type: "addGroup"; listId: ListId; groupId?: GroupId; source?: ListSource }
  | { type: "addTodo"; listId: ListId; groupId?: GroupId; source?: ListSource }
  | { type: "quickAddTodo"; listId: ListId; text: string; groupId?: GroupId; source?: ListSource }
  | { type: "renameList"; listId: ListId; source?: ListSource }
  | { type: "renameGroup"; listId: ListId; groupId: GroupId; source?: ListSource }
  | { type: "renameTodo"; listId: ListId; todoId: TodoId; source?: ListSource }
  | { type: "toggleDone"; listId: ListId; todoId: TodoId; source?: ListSource }
  | { type: "deleteTodo"; listId: ListId; todoId: TodoId; source?: ListSource }
  | { type: "deleteGroup"; listId: ListId; groupId: GroupId; source?: ListSource }
  | { type: "deleteList"; listId: ListId; source?: ListSource }
  | { type: "exportAll" }
  | { type: "exportList"; listId: ListId }
  | { type: "importData" }
  | { type: "moveTodo"; sourceListId: ListId; todoId: TodoId; targetListId: ListId; targetGroupId?: GroupId; source?: ListSource }
  | { type: "moveGroup"; sourceListId: ListId; groupId: GroupId; targetListId: ListId; targetGroupId?: GroupId; source?: ListSource }
  | { type: "refresh" }
  | { type: "shareCurrentList"; listId?: ListId; source?: ListSource }
  | { type: "openListInEditor"; listId: ListId; source?: ListSource }
  | { type: "copyShareKey"; listId: ListId; source?: ListSource }
  | { type: "addSharedList" }
  | { type: "copyLocalListToShareMode" }
  | { type: "syncSharedList"; listId?: ListId; source?: ListSource };

interface RenderedList {
  source: ListSource;
  id: string;
  displayId: string;
  name: string;
  createdAt: number;
  store: TodoStore;
  record?: SharedListRecord;
  sharedBadge?: string;
}

class TodoState {
  private static readonly LISTS_KEY = "todoListPro.lists";
  private static readonly FILTER_KEY = "todoListPro.ui.filter";
  private static readonly VISIBLE_LIST_IDS_KEY = "todoListPro.ui.visibleListIds";
  private static readonly EXPANDED_LIST_ID_KEY = "todoListPro.ui.expandedListId";
  private static readonly SHELL_STATE_KEY = "todoListPro.ui.shellState";
  private static readonly LEGACY_WORKSPACE_KEY = "todoListPro.store.workspace";
  private static readonly LEGACY_PROFILE_KEY = "todoListPro.store.profile";
  private static readonly LEGACY_SCOPE_REGISTRY_KEY = "todoListPro.workspaceScopes";

  private initPromise?: Promise<void>;

  public constructor(private readonly context: vscode.ExtensionContext) {
    this.context.globalState.setKeysForSync([TodoState.LISTS_KEY]);
  }

  public async ensureInitialized(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.initialize();
    }
    await this.initPromise;
  }

  public listLists(): TodoList[] {
    return this.readLists().sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name));
  }

  public getList(listId: ListId): TodoList | undefined {
    return this.readLists().find((list) => list.id === listId);
  }

  public async createList(name: string): Promise<TodoList> {
    const lists = this.readLists();
    const list: TodoList = {
      id: this.newId("list"),
      name: name.trim(),
      createdAt: Date.now(),
      store: { groups: [], todos: [] }
    };
    lists.push(list);
    await this.writeLists(lists);
    await this.ensureListVisible(list.id);
    await this.ensureExpandedListIsValid();
    return list;
  }

  public async updateList(listId: ListId, updater: (list: TodoList) => void): Promise<boolean> {
    const lists = this.readLists();
    const list = lists.find((item) => item.id === listId);
    if (!list) {
      return false;
    }
    updater(list);
    list.store = this.normalizeStore(list.store);
    await this.writeLists(lists);
    return true;
  }

  public async deleteList(listId: ListId): Promise<boolean> {
    const lists = this.readLists();
    const next = lists.filter((list) => list.id !== listId);
    if (next.length === lists.length) {
      return false;
    }
    await this.writeLists(next);
    await this.context.workspaceState.update(
      TodoState.VISIBLE_LIST_IDS_KEY,
      this.readVisibleListIds().filter((id) => id !== listId)
    );
    if (this.readExpandedListId() === listId) {
      await this.context.workspaceState.update(TodoState.EXPANDED_LIST_ID_KEY, undefined);
    }
    return true;
  }

  public readFilter(): string {
    return this.context.workspaceState.get<string>(TodoState.FILTER_KEY, "");
  }

  public async setFilter(value: string): Promise<void> {
    await this.context.workspaceState.update(TodoState.FILTER_KEY, value.trim());
  }

  public readVisibleListIds(): ListId[] {
    const currentIds = new Set(this.readLists().map((list) => list.id));
    const stored = this.context.workspaceState.get<ListId[] | undefined>(TodoState.VISIBLE_LIST_IDS_KEY);
    if (!stored || stored.length === 0) {
      return [...currentIds];
    }
    const filtered = stored.filter((id) => currentIds.has(id));
    return filtered.length > 0 ? filtered : [...currentIds];
  }

  public async ensureListVisible(listId: ListId): Promise<void> {
    const visible = this.readVisibleListIds();
    if (!visible.includes(listId)) {
      await this.context.workspaceState.update(TodoState.VISIBLE_LIST_IDS_KEY, [...visible, listId]);
    }
  }

  public async toggleListVisibility(listId: ListId): Promise<void> {
    const orderedIds = this.listLists().map((list) => list.id);
    const visible = new Set(this.readVisibleListIds());
    if (visible.has(listId)) {
      visible.delete(listId);
    } else {
      visible.add(listId);
    }
    const nextVisible = orderedIds.filter((id) => visible.has(id));
    await this.context.workspaceState.update(TodoState.VISIBLE_LIST_IDS_KEY, nextVisible);
    if (!nextVisible.includes(this.readExpandedListId() ?? "")) {
      await this.context.workspaceState.update(TodoState.EXPANDED_LIST_ID_KEY, nextVisible[0]);
    }
  }

  public readExpandedListId(): ListId | undefined {
    return this.context.workspaceState.get<ListId | undefined>(TodoState.EXPANDED_LIST_ID_KEY);
  }

  public async setExpandedListId(listId?: ListId): Promise<void> {
    await this.context.workspaceState.update(TodoState.EXPANDED_LIST_ID_KEY, listId);
  }

  public async ensureExpandedListIsValid(): Promise<void> {
    const visible = this.readVisibleListIds();
    const expanded = this.readExpandedListId();
    if (expanded && visible.includes(expanded)) {
      return;
    }
    await this.context.workspaceState.update(TodoState.EXPANDED_LIST_ID_KEY, visible[0]);
  }

  public readShellState(): ShellState {
    const raw = this.context.workspaceState.get<Partial<ShellState> | undefined>(TodoState.SHELL_STATE_KEY);
    return { lists: raw?.lists ?? true };
  }

  public async setShellState(shellState: ShellState): Promise<void> {
    await this.context.workspaceState.update(TodoState.SHELL_STATE_KEY, shellState);
  }

  public getCompletedRetentionDays(): number {
    const value = vscode.workspace.getConfiguration("todoListPro").get<number>("completedRetentionDays", 8);
    return Math.max(1, Math.floor(Number.isFinite(value) ? value : 8));
  }

  public async setCompletedRetentionDays(days: number): Promise<void> {
    await vscode.workspace
      .getConfiguration("todoListPro")
      .update("completedRetentionDays", Math.max(1, Math.floor(days)), vscode.ConfigurationTarget.Global);
  }

  public async reload(): Promise<void> {
    this.initPromise = undefined;
    await this.ensureInitialized();
  }

  private async initialize(): Promise<void> {
    const current = this.context.globalState.get<TodoList[] | undefined>(TodoState.LISTS_KEY);
    if (!current) {
      const migrated = this.migrateLegacyData();
      await this.writeLists(migrated);
      await this.context.workspaceState.update(
        TodoState.VISIBLE_LIST_IDS_KEY,
        migrated.map((list) => list.id)
      );
      await this.context.workspaceState.update(TodoState.EXPANDED_LIST_ID_KEY, migrated[0]?.id);
      return;
    }

    await this.writeLists(current);
    if (!this.context.workspaceState.get(TodoState.VISIBLE_LIST_IDS_KEY)) {
      await this.context.workspaceState.update(
        TodoState.VISIBLE_LIST_IDS_KEY,
        this.readLists().map((list) => list.id)
      );
    }
    await this.ensureExpandedListIsValid();
  }

  private readLists(): TodoList[] {
    const raw = this.context.globalState.get<TodoList[] | undefined>(TodoState.LISTS_KEY) ?? [];
    return raw.map((list, index) => ({
      id: typeof list?.id === "string" && list.id ? list.id : this.newId(`list-${index}`),
      name: typeof list?.name === "string" && list.name.trim() ? list.name.trim() : `List ${index + 1}`,
      createdAt: typeof list?.createdAt === "number" ? list.createdAt : Date.now(),
      store: this.normalizeStore(list?.store)
    }));
  }

  private async writeLists(lists: TodoList[]): Promise<void> {
    await this.context.globalState.update(
      TodoState.LISTS_KEY,
      lists.map((list) => ({ ...list, store: this.normalizeStore(list.store) }))
    );
  }

  private migrateLegacyData(): TodoList[] {
    const lists: TodoList[] = [];
    const workspaceStore = this.context.workspaceState.get<LegacyTodoStore | undefined>(TodoState.LEGACY_WORKSPACE_KEY);
    if (workspaceStore) {
      lists.push({ id: this.newId("migrated"), name: "Workspace", createdAt: Date.now(), store: this.normalizeStore(workspaceStore) });
    }
    const profileStore = this.context.globalState.get<LegacyTodoStore | undefined>(TodoState.LEGACY_PROFILE_KEY);
    if (profileStore) {
      lists.push({ id: this.newId("migrated"), name: "Profile", createdAt: Date.now(), store: this.normalizeStore(profileStore) });
    }
    const registry = this.context.globalState.get<LegacyScopeRegistry | undefined>(TodoState.LEGACY_SCOPE_REGISTRY_KEY);
    for (const scope of registry?.scopes ?? []) {
      const store = registry?.stores?.[scope.id];
      if (!store) {
        continue;
      }
      lists.push({
        id: this.newId("migrated"),
        name: scope.name || "Imported List",
        createdAt: typeof scope.createdAt === "number" ? scope.createdAt : Date.now(),
        store: this.normalizeStore(store)
      });
    }
    return lists;
  }

  private normalizeStore(raw?: Partial<TodoStore> | LegacyTodoStore): TodoStore {
    return {
      groups: this.normalizeGroups(raw?.groups ?? []),
      todos: this.normalizeTodos((raw as TodoStore | undefined)?.todos ?? [])
    };
  }

  private normalizeGroups(groups: TodoGroup[]): TodoGroup[] {
    return (groups ?? []).map((group, index) => ({
      id: typeof group?.id === "string" && group.id ? group.id : this.newId(`group-${index}`),
      name: typeof group?.name === "string" && group.name.trim() ? group.name.trim() : "Untitled group",
      groups: this.normalizeGroups(group?.groups ?? []),
      todos: this.normalizeTodos(group?.todos ?? [])
    }));
  }

  private normalizeTodos(todos: TodoItem[]): TodoItem[] {
    return (todos ?? []).map((todo, index) => ({
      id: typeof todo?.id === "string" && todo.id ? todo.id : this.newId(`todo-${index}`),
      text: typeof todo?.text === "string" ? todo.text : "",
      done: Boolean(todo?.done),
      createdAt: typeof todo?.createdAt === "number" ? todo.createdAt : Date.now(),
      completedAt: typeof todo?.completedAt === "number" ? todo.completedAt : undefined
    }));
  }

  private newId(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

class TodoController implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private editorPanel?: vscode.WebviewPanel;
  private editorTarget?: { listId: ListId; source: ListSource };
  private sharedListsCache: SharedListRecord[] = [];
  private autoRefreshTimer?: NodeJS.Timeout;
  private autoRefreshEnabled = vscode.workspace.getConfiguration("todoListPro").get<boolean>("autoRefreshSharedLists", false);
  private readonly autoRefreshIntervalMs = 5 * 60 * 1000;

  public constructor(
    private readonly state: TodoState,
    private readonly extensionUri: vscode.Uri
  ) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")]
    };
    webviewView.webview.onDidReceiveMessage(async (message: WebviewAction) => {
      await this.handleAction(message);
    });
    void this.refresh();
  }

  public async refresh(): Promise<void> {
    await this.state.ensureInitialized();
    await this.cleanupExpiredCompletedTodos();
    await storageManager.sync();
    this.sharedListsCache = await storageManager.listSharedLists();
    this.updateAutoRefreshTimer();
    if (this.view) {
      this.view.webview.html = this.renderHtml();
    }
    if (this.editorPanel) {
      this.editorPanel.webview.html = this.renderEditorHtml();
    }
  }

  public async addList(): Promise<void> {
    const name = await vscode.window.showInputBox({ prompt: "List name", placeHolder: "e.g. CRM Backend" });
    if (!name?.trim()) {
      return;
    }
    const list = await this.state.createList(name);
    await this.state.setExpandedListId(list.id);
    await this.refresh();
  }

  public async addGroup(listId: ListId, groupId?: GroupId, source: ListSource = "local"): Promise<void> {
    if (source === "shared") {
      const record = this.getSharedRecord(listId);
      if (!record) {
        return;
      }
      const parent = groupId ? this.findGroupById(record.snapshot.store.groups, groupId) : undefined;
      const name = await vscode.window.showInputBox({
        prompt: parent ? `Subgroup name in "${parent.name}"` : `Group name in "${record.listName}"`,
        placeHolder: "e.g. Backend"
      });
      if (!name?.trim()) {
        return;
      }
      await storageManager.saveSharedList(record.id, (target) => {
        const next: TodoGroup = { id: this.newId("group"), name: name.trim(), groups: [], todos: [] };
        if (groupId) {
          const current = this.findGroupById(target.store.groups, groupId);
          if (current) {
            current.groups.push(next);
          }
        } else {
          target.store.groups.push(next);
        }
      });
      await this.reloadSharedLists();
      await this.refresh();
      return;
    }

    const list = this.state.getList(listId);
    if (!list) {
      return;
    }
    const parent = groupId ? this.findGroupById(list.store.groups, groupId) : undefined;
    const name = await vscode.window.showInputBox({
      prompt: parent ? `Subgroup name in "${parent.name}"` : `Group name in "${list.name}"`,
      placeHolder: "e.g. Backend"
    });
    if (!name?.trim()) {
      return;
    }
    await this.state.updateList(listId, (target) => {
      const next: TodoGroup = { id: this.newId("group"), name: name.trim(), groups: [], todos: [] };
      if (groupId) {
        const current = this.findGroupById(target.store.groups, groupId);
        if (current) {
          current.groups.push(next);
        }
      } else {
        target.store.groups.push(next);
      }
    });
    await this.state.ensureListVisible(listId);
    await this.state.setExpandedListId(listId);
    await this.refresh();
  }

  public async addTodo(listId: ListId, groupId?: GroupId, source: ListSource = "local"): Promise<void> {
    if (source === "shared") {
      const record = this.getSharedRecord(listId);
      if (!record) {
        return;
      }
      const group = groupId ? this.findGroupById(record.snapshot.store.groups, groupId) : undefined;
      const text = await vscode.window.showInputBox({
        prompt: group ? `TODO text in "${group.name}"` : `TODO text in "${record.listName}"`,
        placeHolder: "e.g. Add API validation"
      });
      if (!text?.trim()) {
        return;
      }
      await storageManager.saveSharedList(record.id, (target) => {
        const todo: TodoItem = { id: this.newId("todo"), text: text.trim(), done: false, createdAt: Date.now() };
        if (groupId) {
          const current = this.findGroupById(target.store.groups, groupId);
          if (current) {
            current.todos.push(todo);
          }
        } else {
          target.store.todos.push(todo);
        }
      });
      await this.reloadSharedLists();
      await this.refresh();
      return;
    }

    const list = this.state.getList(listId);
    if (!list) {
      return;
    }
    const group = groupId ? this.findGroupById(list.store.groups, groupId) : undefined;
    const text = await vscode.window.showInputBox({
      prompt: group ? `TODO text in "${group.name}"` : `TODO text in "${list.name}"`,
      placeHolder: "e.g. Add API validation"
    });
    if (!text?.trim()) {
      return;
    }
    await this.state.updateList(listId, (target) => {
      const todo: TodoItem = { id: this.newId("todo"), text: text.trim(), done: false, createdAt: Date.now() };
      if (groupId) {
        const current = this.findGroupById(target.store.groups, groupId);
        if (current) {
          current.todos.push(todo);
        }
      } else {
        target.store.todos.push(todo);
      }
    });
    await this.state.ensureListVisible(listId);
    await this.state.setExpandedListId(listId);
    await this.refresh();
  }

  public async quickAddTodo(listId: ListId, text: string, groupId?: GroupId, source: ListSource = "local"): Promise<void> {
    const value = text.trim();
    if (!value) {
      return;
    }

    if (source === "shared") {
      const record = this.getSharedRecord(listId);
      if (!record) {
        return;
      }
      await storageManager.saveSharedList(record.id, (target) => {
        const todo: TodoItem = { id: this.newId("todo"), text: value, done: false, createdAt: Date.now() };
        if (groupId) {
          const current = this.findGroupById(target.store.groups, groupId);
          if (current) {
            current.todos.push(todo);
          }
        } else {
          target.store.todos.push(todo);
        }
      });
      await this.reloadSharedLists();
      await this.refresh();
      return;
    }

    const list = this.state.getList(listId);
    if (!list) {
      return;
    }

    await this.state.updateList(listId, (target) => {
      const todo: TodoItem = { id: this.newId("todo"), text: value, done: false, createdAt: Date.now() };
      if (groupId) {
        const current = this.findGroupById(target.store.groups, groupId);
        if (current) {
          current.todos.push(todo);
        }
      } else {
        target.store.todos.push(todo);
      }
    });
    await this.state.ensureListVisible(listId);
    await this.state.setExpandedListId(listId);
    await this.refresh();
  }

  public async renameList(listId: ListId, source: ListSource = "local"): Promise<void> {
    if (source === "shared") {
      const record = this.getSharedRecord(listId);
      if (!record) {
        return;
      }
      const name = await vscode.window.showInputBox({
        prompt: "Rename list",
        value: record.listName,
        placeHolder: "e.g. CRM Backend"
      });
      if (!name?.trim() || name.trim() === record.listName) {
        return;
      }
      await storageManager.saveSharedList(record.id, (target) => {
        target.name = name.trim();
      });
      await this.reloadSharedLists();
      await this.refresh();
      return;
    }

    const list = this.state.getList(listId);
    if (!list) {
      return;
    }
    const name = await vscode.window.showInputBox({
      prompt: "Rename list",
      value: list.name,
      placeHolder: "e.g. CRM Backend"
    });
    if (!name?.trim() || name.trim() === list.name) {
      return;
    }
    await this.state.updateList(listId, (target) => {
      target.name = name.trim();
    });
    await this.refresh();
  }

  public async renameGroup(listId: ListId, groupId: GroupId, source: ListSource = "local"): Promise<void> {
    if (source === "shared") {
      const record = this.getSharedRecord(listId);
      if (!record) {
        return;
      }
      const group = record ? this.findGroupById(record.snapshot.store.groups, groupId) : undefined;
      if (!group) {
        return;
      }
      const name = await vscode.window.showInputBox({
        prompt: "Rename folder",
        value: group.name,
        placeHolder: "e.g. Backend"
      });
      if (!name?.trim() || name.trim() === group.name) {
        return;
      }
      await storageManager.saveSharedList(record.id, (target) => {
        const current = this.findGroupById(target.store.groups, groupId);
        if (current) {
          current.name = name.trim();
        }
      });
      await this.reloadSharedLists();
      await this.refresh();
      return;
    }

    const list = this.state.getList(listId);
    const group = list ? this.findGroupById(list.store.groups, groupId) : undefined;
    if (!group) {
      return;
    }
    const name = await vscode.window.showInputBox({
      prompt: "Rename folder",
      value: group.name,
      placeHolder: "e.g. Backend"
    });
    if (!name?.trim() || name.trim() === group.name) {
      return;
    }
    await this.state.updateList(listId, (target) => {
      const current = this.findGroupById(target.store.groups, groupId);
      if (current) {
        current.name = name.trim();
      }
    });
    await this.refresh();
  }

  public async renameTodo(listId: ListId, todoId: TodoId, source: ListSource = "local"): Promise<void> {
    if (source === "shared") {
      const record = this.getSharedRecord(listId);
      if (!record) {
        return;
      }
      const todo = record ? this.findTodo(record.snapshot.store, todoId) : undefined;
      if (!todo) {
        return;
      }
      const text = await vscode.window.showInputBox({
        prompt: "Rename task",
        value: todo.text,
        placeHolder: "e.g. Add API validation"
      });
      if (!text?.trim() || text.trim() === todo.text) {
        return;
      }
      await storageManager.saveSharedList(record.id, (target) => {
        const current = this.findTodo(target.store, todoId);
        if (current) {
          current.text = text.trim();
        }
      });
      await this.reloadSharedLists();
      await this.refresh();
      return;
    }

    const list = this.state.getList(listId);
    const todo = list ? this.findTodo(list.store, todoId) : undefined;
    if (!todo) {
      return;
    }
    const text = await vscode.window.showInputBox({
      prompt: "Rename task",
      value: todo.text,
      placeHolder: "e.g. Add API validation"
    });
    if (!text?.trim() || text.trim() === todo.text) {
      return;
    }
    await this.state.updateList(listId, (target) => {
      const current = this.findTodo(target.store, todoId);
      if (current) {
        current.text = text.trim();
      }
    });
    await this.refresh();
  }

  public async setFilter(value: string): Promise<void> {
    await this.state.setFilter(value);
    await this.refresh();
  }

  public async clearFilter(): Promise<void> {
    await this.setFilter("");
  }

  public async toggleDone(listId: ListId, todoId: TodoId, source: ListSource = "local"): Promise<void> {
    if (source === "shared") {
      const record = this.getSharedRecord(listId);
      if (!record) {
        return;
      }
      await storageManager.saveSharedList(record.id, (list) => {
        const todo = this.findTodo(list.store, todoId);
        if (todo) {
          todo.done = !todo.done;
          todo.completedAt = todo.done ? Date.now() : undefined;
        }
      });
      await this.reloadSharedLists();
      await this.refresh();
      return;
    }

    await this.state.updateList(listId, (list) => {
      const todo = this.findTodo(list.store, todoId);
      if (todo) {
        todo.done = !todo.done;
        todo.completedAt = todo.done ? Date.now() : undefined;
      }
    });
    await this.refresh();
  }

  public async deleteTodo(listId: ListId, todoId: TodoId, source: ListSource = "local"): Promise<void> {
    if (source === "shared") {
      const record = this.getSharedRecord(listId);
      if (!record) {
        return;
      }
      await storageManager.saveSharedList(record.id, (list) => {
        this.removeTodo(list.store, todoId);
      });
      await this.reloadSharedLists();
      await this.refresh();
      return;
    }

    await this.state.updateList(listId, (list) => {
      this.removeTodo(list.store, todoId);
    });
    await this.refresh();
  }

  public async deleteGroup(listId: ListId, groupId: GroupId, source: ListSource = "local"): Promise<void> {
    if (source === "shared") {
      const record = this.getSharedRecord(listId);
      if (!record) {
        return;
      }
      await storageManager.saveSharedList(record.id, (list) => {
        this.removeGroup(list.store.groups, groupId);
      });
      await this.reloadSharedLists();
      await this.refresh();
      return;
    }

    await this.state.updateList(listId, (list) => {
      this.removeGroup(list.store.groups, groupId);
    });
    await this.refresh();
  }

  public async deleteList(listId: ListId, source: ListSource = "local"): Promise<void> {
    if (source === "shared") {
      const record = this.getSharedRecord(listId);
      if (!record) {
        return;
      }
      const picked = await vscode.window.showWarningMessage(
        `Shared list "${record.listName}" is backed by a GitHub repository. Remove only this local copy to hide it from this workspace, or delete the remote JSON to remove it for everyone with access.`,
        { modal: true },
        "Delete local copy",
        "Delete remote list",
        "Cancel"
      );

      if (picked === "Delete local copy") {
        await storageManager.deleteSharedList(record.id);
        await this.reloadSharedLists();
        await this.refresh();
        return;
      }

      if (picked !== "Delete remote list") {
        return;
      }

      const confirmRemote = await vscode.window.showWarningMessage(
        `This will permanently delete "${record.listName}" from GitHub repository ${record.target.owner}/${record.target.repo} on branch ${record.target.branch}. Continue?`,
        { modal: true },
        "Delete remote list",
        "Cancel"
      );
      if (confirmRemote !== "Delete remote list") {
        return;
      }

      await storageManager.deleteRemoteSharedList(record.id);
      await this.reloadSharedLists();
      await this.refresh();
      return;
    }

    const list = this.state.getList(listId);
    if (!list) {
      return;
    }
    const confirm = await vscode.window.showWarningMessage(`Delete list "${list.name}"?`, { modal: true }, "Delete");
    if (confirm !== "Delete") {
      return;
    }
    await this.state.deleteList(listId);
    await this.state.ensureExpandedListIsValid();
    await this.refresh();
  }

  public async toggleListExpanded(listId: ListId): Promise<void> {
    await this.state.setExpandedListId(this.state.readExpandedListId() === listId ? undefined : listId);
    await this.refresh();
  }

  public async toggleListVisibility(listId: ListId): Promise<void> {
    await this.state.toggleListVisibility(listId);
    await this.refresh();
  }

  public async setCompletedRetentionDays(days: number): Promise<void> {
    await this.state.setCompletedRetentionDays(days);
    await this.refresh();
  }

  private getSharedRecord(recordId: string): SharedListRecord | undefined {
    return this.sharedListsCache.find((record) => record.id === recordId);
  }

  private async reloadSharedLists(): Promise<void> {
    this.sharedListsCache = await storageManager.listSharedLists();
    this.updateAutoRefreshTimer();
  }

  private updateAutoRefreshTimer(): void {
    if (this.autoRefreshTimer) {
      clearInterval(this.autoRefreshTimer);
      this.autoRefreshTimer = undefined;
    }

    if (!this.autoRefreshEnabled || this.sharedListsCache.length === 0) {
      return;
    }

    this.autoRefreshTimer = setInterval(() => {
      void this.refresh();
    }, this.autoRefreshIntervalMs);
  }

  private async pickLocalList(listId?: ListId): Promise<TodoList | undefined> {
    await this.state.ensureInitialized();
    const lists = this.state.listLists();
    if (lists.length === 0) {
      void vscode.window.showInformationMessage("Create a list first.");
      return undefined;
    }
    if (listId) {
      const pickedList = lists.find((list) => list.id === listId);
      if (pickedList) {
        return pickedList;
      }
    }
    const picked = await vscode.window.showQuickPick(
      lists.map((list) => ({ label: list.name, description: `${list.store.groups.length} groups`, list })),
      { title: "Select local list" }
    );
    return picked?.list;
  }

  private async pickSharedList(): Promise<SharedListRecord | undefined> {
    if (this.sharedListsCache.length === 0) {
      void vscode.window.showInformationMessage("Add a shared list first.");
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      this.sharedListsCache.map((record) => ({
        label: record.listName,
        description: `${record.target.owner}/${record.target.repo}#${record.target.branch}`,
        record
      })),
      { title: "Select shared list" }
    );
    return picked?.record;
  }

  public async configureWorkspaceVisibility(): Promise<void> {
    const lists = this.state.listLists();
    if (lists.length === 0) {
      void vscode.window.showInformationMessage("Create a list first.");
      return;
    }

    const visibleIds = new Set(this.state.readVisibleListIds());
    const picked = await vscode.window.showQuickPick(
      lists.map((list) => ({
        label: list.name,
        picked: visibleIds.has(list.id),
        description: `${list.store.groups.length} folders | ${this.countVisibleTodos(list.store, "")} tasks`,
        listId: list.id
      })),
      {
        title: "Workspace Visibility",
        canPickMany: true,
        placeHolder: "Select lists visible in the current workspace"
      }
    );

    if (!picked) {
      return;
    }

    const selectedIds = new Set(picked.map((item) => item.listId));
    for (const list of lists) {
      const isVisible = visibleIds.has(list.id);
      const shouldBeVisible = selectedIds.has(list.id);
      if (isVisible !== shouldBeVisible) {
        await this.state.toggleListVisibility(list.id);
      }
    }

    await this.state.ensureExpandedListIsValid();
    await this.refresh();
  }

  public async configureCompletedRetention(): Promise<void> {
    const current = this.state.getCompletedRetentionDays();
    const picked = await vscode.window.showQuickPick(
      [1, 3, 8, 14, 30, 90].map((days) => ({
        label: `${days} day${days === 1 ? "" : "s"}`,
        description: current === days ? "current" : undefined,
        days
      })),
      {
        title: "Completed Retention",
        placeHolder: "Choose how long completed TODOs should be kept"
      }
    );

    if (!picked) {
      return;
    }

    await this.setCompletedRetentionDays(picked.days);
  }

  public async configureStorageMode(): Promise<void> {
    const currentMode = storageManager.getStorageMode();
    const picked = await vscode.window.showQuickPick(
      [
        {
          label: currentMode === "local" ? "Keep local storage" : "Back to Local Mode",
          description: currentMode === "local" ? "current" : "Switch back without deleting shared metadata or local data.",
          mode: "local" as const
        },
        {
          label: "Switch to Share Mode",
          description: "Keeps local data untouched and enables shared list workflows.",
          mode: "github-switch" as const
        }
      ],
      {
        title: "Storage Mode",
        placeHolder: "Choose how TODO lists should be stored"
      }
    );

    if (!picked) {
      return;
    }

    if (picked.mode === "local") {
      await storageManager.switchToLocal();
      await this.refresh();
      void vscode.window.showInformationMessage("Local storage is active. Existing local data was preserved.");
      return;
    }

    if (picked.mode === "github-switch") {
      try {
        await storageManager.switchToShare();
        await this.refresh();
        void vscode.window.showInformationMessage("Share Mode is active. Local data was preserved.");
      } catch (error) {
        void vscode.window.showErrorMessage(error instanceof Error ? error.message : "Failed to initialize Share Mode.");
      }
      return;
    }
  }

  public async shareCurrentList(listId?: ListId): Promise<void> {
    const list = await this.pickLocalList(listId);
    if (!list) {
      return;
    }

    try {
      const record = await storageManager.shareLocalList(list);
      const target = record.target;
      const shareKey = storageManager.createShareKey(target, record.listId, record.listName);
      await vscode.env.clipboard.writeText(shareKey);
      await this.reloadSharedLists();
      await this.state.setExpandedListId(record.id);
      await this.refresh();
      void vscode.window.showInformationMessage(`Share key was copied to clipboard. Shared "${record.listName}" to ${target.owner}/${target.repo}.`);
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : "Failed to share list.");
    }
  }

  public async openListInEditor(listId?: ListId, source: ListSource = "local"): Promise<void> {
    const target = source === "shared" ? this.getSharedRecord(listId ?? "") : this.state.getList(listId ?? "");
    if (!target) {
      if (source === "shared") {
        void vscode.window.showInformationMessage("Open a shared list first.");
      } else {
        void vscode.window.showInformationMessage("Select a local list first.");
      }
      return;
    }

    this.editorTarget = { listId: listId ?? target.id, source };
    const title = source === "shared" ? `Shared: ${(target as SharedListRecord).listName}` : (target as TodoList).name;
    const panel = vscode.window.createWebviewPanel(
      "todoListProEditor",
      title,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")]
      }
    );
    this.editorPanel = panel;
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")]
    };
    panel.webview.onDidReceiveMessage(async (message: WebviewAction) => {
      await this.handleAction(message);
    });
    panel.onDidDispose(() => {
      if (this.editorPanel === panel) {
        this.editorPanel = undefined;
        this.editorTarget = undefined;
      }
    });
    panel.webview.html = this.renderEditorHtml();
  }

  public async copyShareKey(listId: ListId, source: ListSource = "shared"): Promise<void> {
    if (source === "shared") {
      const record = this.getSharedRecord(listId);
      if (!record) {
        return;
      }
      const shareKey = storageManager.createShareKey(record.target, record.listId, record.listName);
      await vscode.env.clipboard.writeText(shareKey);
      void vscode.window.showInformationMessage(`Share key copied to clipboard for "${record.listName}".`);
      return;
    }

    const list = this.state.getList(listId);
    if (!list) {
      return;
    }
    const record = this.sharedListsCache.find((item) => item.listId === list.id);
    if (!record) {
      void vscode.window.showInformationMessage("Share the list first to copy its share key.");
      return;
    }
    const shareKey = storageManager.createShareKey(record.target, record.listId, record.listName);
    await vscode.env.clipboard.writeText(shareKey);
    void vscode.window.showInformationMessage(`Share key copied to clipboard for "${record.listName}".`);
  }

  public async copyLocalListToShareMode(): Promise<void> {
    await this.shareCurrentList();
  }

  public async addSharedList(): Promise<void> {
    const shareKey = await vscode.window.showInputBox({
      prompt: "Paste share key",
      placeHolder: "todo-share://..."
    });
    if (!shareKey?.trim()) {
      return;
    }

    try {
      const decoded = await storageManager.getSharedProvider().loadFromShareKey(shareKey.trim());
      const localConflict = this.state.getList(decoded.listId);
      if (localConflict) {
        const picked = await vscode.window.showWarningMessage(
          `A local list with the same id already exists: "${localConflict.name}". What do you want to do?`,
          { modal: true },
          "Open as shared list",
          "Create local copy",
          "Cancel"
        );

        if (picked === "Create local copy") {
          const { snapshot } = await storageManager.getSharedProvider().loadSnapshot(decoded.target);
          const created = await this.state.createList(`${snapshot.listName} (copy)`);
          await this.state.updateList(created.id, (target) => {
            target.store = this.cloneStore(snapshot.store);
          });
          await this.refresh();
          void vscode.window.showInformationMessage(`Created local copy of "${snapshot.listName}".`);
          return;
        }

        if (picked !== "Open as shared list") {
          return;
        }
      }

      const record = await storageManager.addSharedListFromShareKey(shareKey.trim());
      await this.reloadSharedLists();
      await this.state.setExpandedListId(record.id);
      await this.refresh();
      void vscode.window.showInformationMessage(`Loaded shared list "${record.listName}".`);
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : "Failed to add shared list.");
    }
  }

  public async syncSharedList(recordId?: string): Promise<void> {
    const record = recordId ? this.getSharedRecord(recordId) : await this.pickSharedList();
    if (!record) {
      return;
    }
    try {
      await storageManager.syncSharedList(record.id);
      await this.reloadSharedLists();
      await this.refresh();
      void vscode.window.showInformationMessage(`Synced shared list "${record.listName}".`);
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : "Failed to sync shared list.");
    }
  }

  public async toggleAutoRefreshSharedLists(): Promise<void> {
    this.autoRefreshEnabled = !this.autoRefreshEnabled;
    await vscode.workspace
      .getConfiguration("todoListPro")
      .update("autoRefreshSharedLists", this.autoRefreshEnabled, vscode.ConfigurationTarget.Global);
    this.updateAutoRefreshTimer();
    void vscode.window.showInformationMessage(
      this.autoRefreshEnabled
        ? "Automatic refresh enabled. Shared lists will refresh every 5 minutes when present."
        : "Automatic refresh disabled."
    );
  }

  public async exportAll(): Promise<void> {
    await this.writeExportFile(this.state.listLists(), "todo-lists-export.json");
  }

  public async exportList(listId: ListId): Promise<void> {
    const list = this.state.getList(listId);
    if (list) {
      await this.writeExportFile([list], `${this.slugify(list.name)}.json`);
    }
  }

  public async exportSingleList(): Promise<void> {
    const lists = this.state.listLists();
    if (lists.length === 0) {
      void vscode.window.showInformationMessage("Create a list first.");
      return;
    }

    const picked = await vscode.window.showQuickPick(
      lists.map((list) => ({
        label: list.name,
        description: `${list.store.groups.length} folders | ${this.countVisibleTodos(list.store, "")} tasks`,
        listId: list.id
      })),
      {
        title: "Export Single List",
        placeHolder: "Select a list to export"
      }
    );

    if (!picked) {
      return;
    }

    await this.exportList(picked.listId);
  }

  public async importData(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectMany: false,
      openLabel: "Import TODO lists",
      filters: { JSON: ["json"] }
    });
    const file = picked?.[0];
    if (!file) {
      return;
    }

    try {
      const content = await vscode.workspace.fs.readFile(file);
      const raw = JSON.parse(Buffer.from(content).toString("utf8"));
      const imported = this.normalizeImportedLists(raw);
      if (imported.length === 0) {
        throw new Error("The selected file does not contain any importable lists.");
      }

      for (const list of imported) {
        const created = await this.state.createList(list.name);
        await this.state.updateList(created.id, (target) => {
          target.store = this.cloneStore(list.store);
        });
      }

      await this.state.ensureExpandedListIsValid();
      await this.refresh();
      void vscode.window.showInformationMessage(`Imported ${imported.length} list${imported.length === 1 ? "" : "s"}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to import TODO data.";
      void vscode.window.showErrorMessage(message);
    }
  }

  public async moveTodo(
    sourceListId: ListId,
    todoId: TodoId,
    targetListId: ListId,
    targetGroupId?: GroupId,
    source: ListSource = "local"
  ): Promise<void> {
    if (source === "shared") {
      const record = this.getSharedRecord(sourceListId);
      const target = this.getSharedRecord(targetListId);
      if (!record || !target || record.id !== target.id) {
        void vscode.window.showWarningMessage("Shared items can only be moved within the same shared list.");
        return;
      }
      const nextStore = this.cloneStore(record.snapshot.store);
      const todo = this.removeTodo(nextStore, todoId);
      if (!todo) {
        return;
      }
      if (!this.insertTodo(nextStore, todo, targetGroupId)) {
        return;
      }
      await storageManager.saveSharedList(record.id, (list) => {
        list.store = nextStore;
      });
      await this.reloadSharedLists();
      await this.refresh();
      return;
    }

    const sourceList = this.state.getList(sourceListId);
    const targetList = this.state.getList(targetListId);
    if (!sourceList || !targetList) {
      return;
    }

    const nextSource = this.cloneStore(sourceList.store);
    const todo = this.removeTodo(nextSource, todoId);
    if (!todo) {
      return;
    }

    if (sourceListId === targetListId) {
      if (!this.insertTodo(nextSource, todo, targetGroupId)) {
        return;
      }
      await this.state.updateList(sourceListId, (list) => {
        list.store = nextSource;
      });
    } else {
      const nextTarget = this.cloneStore(targetList.store);
      if (!this.insertTodo(nextTarget, todo, targetGroupId)) {
        return;
      }
      await this.state.updateList(sourceListId, (list) => {
        list.store = nextSource;
      });
      await this.state.updateList(targetListId, (list) => {
        list.store = nextTarget;
      });
    }

    await this.state.ensureListVisible(targetListId);
    await this.state.setExpandedListId(targetListId);
    await this.refresh();
  }

  public async moveGroup(
    sourceListId: ListId,
    groupId: GroupId,
    targetListId: ListId,
    targetGroupId?: GroupId,
    source: ListSource = "local"
  ): Promise<void> {
    if (source === "shared") {
      const record = this.getSharedRecord(sourceListId);
      const target = this.getSharedRecord(targetListId);
      if (!record || !target || record.id !== target.id) {
        void vscode.window.showWarningMessage("Shared folders can only be moved within the same shared list.");
        return;
      }
      const nextGroups = this.cloneStore(record.snapshot.store).groups;
      const group = this.removeGroup(nextGroups, groupId);
      if (!group) {
        return;
      }
      if (this.containsGroup(group, targetGroupId) || group.id === targetGroupId) {
        void vscode.window.showWarningMessage("A group cannot be moved into itself or its descendant.");
        return;
      }
      if (!this.insertGroup(nextGroups, group, targetGroupId)) {
        return;
      }
      await storageManager.saveSharedList(record.id, (list) => {
        list.store.groups = nextGroups;
      });
      await this.reloadSharedLists();
      await this.refresh();
      return;
    }

    const sourceList = this.state.getList(sourceListId);
    const targetList = this.state.getList(targetListId);
    if (!sourceList || !targetList) {
      return;
    }

    const nextSource = this.cloneStore(sourceList.store);
    const group = this.removeGroup(nextSource.groups, groupId);
    if (!group) {
      return;
    }
    if (this.containsGroup(group, targetGroupId) || group.id === targetGroupId) {
      void vscode.window.showWarningMessage("A group cannot be moved into itself or its descendant.");
      return;
    }

    if (sourceListId === targetListId) {
      if (!this.insertGroup(nextSource.groups, group, targetGroupId)) {
        return;
      }
      await this.state.updateList(sourceListId, (list) => {
        list.store = nextSource;
      });
    } else {
      const nextTarget = this.cloneStore(targetList.store);
      if (!this.insertGroup(nextTarget.groups, group, targetGroupId)) {
        return;
      }
      await this.state.updateList(sourceListId, (list) => {
        list.store = nextSource;
      });
      await this.state.updateList(targetListId, (list) => {
        list.store = nextTarget;
      });
    }

    await this.state.ensureListVisible(targetListId);
    await this.state.setExpandedListId(targetListId);
    await this.refresh();
  }

  private async handleAction(action: WebviewAction): Promise<void> {
    switch (action.type) {
      case "setFilter":
        await this.setFilter(action.value);
        return;
      case "clearFilter":
        await this.clearFilter();
        return;
      case "toggleShellSection": {
        const shellState = this.state.readShellState();
        shellState[action.shellId] = !shellState[action.shellId];
        await this.state.setShellState(shellState);
        await this.refresh();
        return;
      }
      case "toggleListExpanded":
        await this.toggleListExpanded(action.listId);
        return;
      case "addList":
        await this.addList();
        return;
      case "addGroup":
        await this.addGroup(action.listId, action.groupId, action.source ?? "local");
        return;
      case "addTodo":
        await this.addTodo(action.listId, action.groupId, action.source ?? "local");
        return;
      case "quickAddTodo":
        await this.quickAddTodo(action.listId, action.text, action.groupId, action.source ?? "local");
        return;
      case "renameList":
        await this.renameList(action.listId, action.source ?? "local");
        return;
      case "renameGroup":
        await this.renameGroup(action.listId, action.groupId, action.source ?? "local");
        return;
      case "renameTodo":
        await this.renameTodo(action.listId, action.todoId, action.source ?? "local");
        return;
      case "toggleDone":
        await this.toggleDone(action.listId, action.todoId, action.source ?? "local");
        return;
      case "deleteTodo":
        await this.deleteTodo(action.listId, action.todoId, action.source ?? "local");
        return;
      case "deleteGroup":
        await this.deleteGroup(action.listId, action.groupId, action.source ?? "local");
        return;
      case "deleteList":
        await this.deleteList(action.listId, action.source ?? "local");
        return;
      case "exportAll":
        await this.exportAll();
        return;
      case "exportList":
        await this.exportList(action.listId);
        return;
      case "importData":
        await this.importData();
        return;
      case "moveTodo":
        await this.moveTodo(action.sourceListId, action.todoId, action.targetListId, action.targetGroupId, action.source ?? "local");
        return;
      case "moveGroup":
        await this.moveGroup(action.sourceListId, action.groupId, action.targetListId, action.targetGroupId, action.source ?? "local");
        return;
      case "shareCurrentList":
        await this.shareCurrentList(action.listId);
        return;
      case "openListInEditor":
        await this.openListInEditor(action.listId, action.source ?? "local");
        return;
      case "copyShareKey":
        await this.copyShareKey(action.listId, action.source ?? "shared");
        return;
      case "addSharedList":
        await this.addSharedList();
        return;
      case "copyLocalListToShareMode":
        await this.copyLocalListToShareMode();
        return;
      case "syncSharedList":
        await this.syncSharedList(action.listId);
        return;
      case "refresh":
        await this.refresh();
        return;
    }
  }

  private renderHtml(): string {
    return this.renderHtmlForMode(undefined);
  }

  private renderEditorHtml(): string {
    return this.renderHtmlForMode(this.editorTarget);
  }

  private renderHtmlForMode(target?: { listId: ListId; source: ListSource }): string {
    const codiconCssUri = this.view?.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "codicons", "codicon.css"))
      ?? this.editorPanel?.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "codicons", "codicon.css"))
      ?? "";
    const filter = this.state.readFilter();
    const shellState = this.state.readShellState();
    const visibleIds = new Set(this.state.readVisibleListIds());
    const allLists = this.buildRenderableLists();
    const storageMode = storageManager.getStorageMode();
    const retentionDays = this.state.getCompletedRetentionDays();
    const sharedCount = allLists.filter((list) => list.source === "shared").length;
    const autoRefreshLabel = this.autoRefreshEnabled
      ? sharedCount > 0
        ? "on"
        : "on, waiting for shared list"
      : "off";
    const renderedLists = target
      ? allLists.filter((list) => list.displayId === target.listId && list.source === target.source)
      : allLists.filter((list) => list.source === "shared" || visibleIds.has(list.id));
    const expandedListId = target ? target.listId : this.state.readExpandedListId();
    const statusRow = `<div class="status-row" aria-label="Current settings"><span class="status-chip"><span class="status-label">Storage</span><span class="status-value">${this.escapeHtml(storageMode)}</span></span><span class="status-chip"><span class="status-label">Retention</span><span class="status-value">${retentionDays} days</span></span><span class="status-chip"><span class="status-label">Auto refresh</span><span class="status-value">${this.escapeHtml(autoRefreshLabel)}</span></span></div>`;

    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><link rel="stylesheet" href="${codiconCssUri}" />
<style>
:root{--bg:var(--vscode-sideBar-background);--panel:var(--vscode-editorWidget-background,var(--vscode-sideBarSectionHeader-background,var(--vscode-sideBar-background)));--panel-2:var(--vscode-input-background);--border:var(--vscode-widget-border,var(--vscode-sideBar-border));--text:var(--vscode-foreground);--muted:var(--vscode-descriptionForeground);--hover:var(--vscode-list-hoverBackground);--focus:var(--vscode-focusBorder);--button:var(--vscode-button-secondaryBackground);--buttonText:var(--vscode-button-secondaryForeground);--danger:var(--vscode-errorForeground,#f85149);--dangerBg:color-mix(in srgb,var(--danger) 14%, transparent);--shared:var(--vscode-charts-purple,#7c9cff)}
 *{box-sizing:border-box}html,body{margin:0;padding:0;background:var(--bg);color:var(--text);font:13px/1.4 var(--vscode-font-family)}body{padding:12px;min-width:230px}button,input{font:inherit;color:inherit}.app{display:flex;flex-direction:column;gap:12px}.toolbar{display:flex;align-items:flex-start;gap:8px}.status-row{display:flex;flex-wrap:wrap;gap:8px}.status-chip{display:inline-flex;align-items:baseline;gap:6px;padding:6px 10px;border:1px solid var(--border);border-radius:999px;background:color-mix(in srgb,var(--panel) 82%, transparent);color:var(--text);font-size:12px;line-height:1}.status-label{color:var(--muted);text-transform:uppercase;letter-spacing:.04em;font-size:10px}.status-value{font-weight:600}.filter{flex:1;min-width:0;padding:8px 10px;border:1px solid var(--border);background:var(--panel-2);color:var(--text);border-radius:8px}.btn{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border:1px solid var(--border);background:var(--button);color:var(--buttonText);border-radius:8px;cursor:pointer;transition:background .12s ease,border-color .12s ease,color .12s ease}.btn:hover,.action:hover,.list-row:hover,.todo-row:hover,.group-summary:hover,.quick-add-row:hover{background:var(--hover)}.icon{display:inline-flex;align-items:center;justify-content:center;font-size:14px;line-height:1;transition:transform .12s ease,color .12s ease,opacity .12s ease}.btn:hover .icon,.action:hover .icon{transform:scale(1.06)}.section{border:1px solid var(--border);border-radius:12px;overflow:hidden;background:var(--panel)}.section-header{display:flex;align-items:center;gap:10px;padding:10px 12px;cursor:pointer}.section.closed .section-body{display:none}.section-body{padding:10px}.title{font-weight:600}.meta{margin-left:auto;color:var(--muted);font-size:12px;flex:0 1 auto;white-space:nowrap;overflow:hidden}.stack{display:flex;flex-direction:column;gap:8px}.list-card{border:1px solid var(--border);border-radius:10px;overflow:hidden;background:var(--panel-2)}.list-card.shared{border-color:color-mix(in srgb,var(--shared) 40%, var(--border));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--shared) 18%, transparent)}.list-row{position:relative;display:flex;align-items:center;gap:8px;padding:10px;min-width:0}.grow{flex:1 1 auto;min-width:0}.label{display:block;white-space:normal;overflow-wrap:anywhere;word-break:break-word}.list-row .label.title{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;overflow-wrap:normal;word-break:normal}.list-stats{display:inline-flex;align-items:center;gap:8px;color:var(--muted);font-size:12px;flex:0 1 auto;min-width:0}.stat-pill{display:inline-flex;align-items:center;gap:4px;white-space:nowrap}.stat-pill .icon{font-size:13px}.badge{display:inline-flex;align-items:center;gap:4px;padding:2px 6px;border-radius:999px;background:color-mix(in srgb,var(--shared) 16%, transparent);color:var(--shared);font-size:11px;line-height:1;white-space:nowrap}.actions,.hover-tools{position:absolute;right:10px;top:50%;transform:translateY(-50%);display:inline-flex;gap:6px;opacity:0;pointer-events:none;transition:opacity .12s ease;z-index:2;padding-left:8px;background:linear-gradient(90deg, transparent 0%, color-mix(in srgb,var(--panel-2) 72%, transparent) 18%, var(--panel-2) 38%)}.group-summary .hover-tools,.todo-row .hover-tools{background:linear-gradient(90deg, transparent 0%, color-mix(in srgb,var(--panel) 72%, transparent) 18%, var(--panel) 38%)}.list-card:hover .actions,.list-card:focus-within .actions,.todo-row:hover .hover-tools,.todo-row:focus-within .hover-tools,.group-summary:hover .hover-tools,.group:focus-within .hover-tools{opacity:1;pointer-events:auto}.action{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border:1px solid transparent;background:transparent;color:var(--text);border-radius:6px;cursor:pointer;transition:background .12s ease,border-color .12s ease,color .12s ease,transform .12s ease}.action:hover{border-color:var(--border);transform:translateY(-1px)}.action-danger{color:var(--danger)}.action-danger:hover{border-color:color-mix(in srgb,var(--danger) 55%, var(--border));background:var(--dangerBg)}.content{display:flex;flex-direction:column;gap:8px;padding:10px;border-top:1px solid var(--border)}.drop-target.over{outline:1px solid var(--focus);outline-offset:-1px}.group{border:1px solid var(--border);border-radius:8px;overflow:hidden;background:var(--panel)}.group-summary{position:relative;list-style:none;display:flex;align-items:flex-start;gap:8px;padding:8px 10px;cursor:pointer}.group-summary::-webkit-details-marker{display:none}.group-body{display:flex;flex-direction:column;gap:8px;padding:0 10px 10px 18px}.todo-row{position:relative;display:flex;align-items:flex-start;gap:8px;padding:7px 10px;border-radius:8px}.todo-main{display:flex;flex-direction:column;gap:2px;min-width:0;padding-top:1px}.todo-date{font-size:11px;color:var(--muted);opacity:0;max-height:0;overflow:hidden;transform:translateY(-2px);transition:opacity .12s ease,max-height .12s ease,transform .12s ease}.todo-row:hover .todo-date,.todo-row:focus-within .todo-date{opacity:1;max-height:18px;transform:translateY(0)}.quick-add-row{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px dashed var(--border);border-radius:8px;background:color-mix(in srgb,var(--panel) 80%, transparent)}.quick-add-input{flex:1;min-width:0;padding:6px 8px;border:1px solid var(--border);background:var(--panel-2);color:var(--text);border-radius:6px}.check{width:18px;height:18px;border:1.5px solid color-mix(in srgb,var(--text) 55%, var(--border));border-radius:5px;background:color-mix(in srgb,var(--panel-2) 88%, white 12%);cursor:pointer;padding:0;position:relative;flex:0 0 auto;margin-top:1px;box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--bg) 55%, transparent)}.check:hover{border-color:var(--focus);background:color-mix(in srgb,var(--hover) 55%, var(--panel-2))}.check.done{background:var(--vscode-testing-iconPassed,#2ea043);border-color:var(--vscode-testing-iconPassed,#2ea043);box-shadow:none}.check.done::after{content:'';position:absolute;left:5px;top:1px;width:4px;height:9px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg)}.done{text-decoration:line-through;color:var(--muted)}.empty{padding:8px;color:var(--muted)}.caret{transition:transform .12s ease}.section.closed .caret,.details-caret{transform:rotate(-90deg)}details[open]>.group-summary .details-caret,.list-card.expanded .caret-list{transform:rotate(0)}.caret-list{transform:rotate(-90deg)}@media (max-width: 320px){.list-stats{display:none}}
 </style>
<style>.badge-icon{padding:4px 6px}.action-share{color:var(--shared)}.action-share:hover{border-color:color-mix(in srgb,var(--shared) 60%, var(--border));background:color-mix(in srgb,var(--shared) 14%, transparent)}</style></head><body><div class="app">
<div class="toolbar"><input id="filter" class="filter" type="text" value="${this.escapeHtml(filter)}" placeholder="Filter tasks and folders" />${filter ? `<button class="btn" data-action="clearFilter" title="Clear filter">${this.icon("clear")}</button>` : ""}</div>
${statusRow}
<section class="section ${shellState.lists ? "" : "closed"}"><div class="section-header" data-action="toggleShellSection" data-shell-id="lists"><span class="caret">${this.icon("chevron")}</span><span class="title">${target ? "List Editor" : "Lists"}</span><span class="meta">${renderedLists.filter((list) => list.source === "local").length} local / ${renderedLists.filter((list) => list.source === "shared").length} shared</span></div><div class="section-body"><div class="stack">${renderedLists.map((list) => this.renderListCard(list, expandedListId === list.id, filter)).join("") || '<div class="empty">No visible lists.</div>'}</div></div></section>
</div>
<script>
const vscode=acquireVsCodeApi();
const readState=()=>vscode.getState()||{};
const writeState=next=>vscode.setState(next);
const findQuickAddInput=(listId,groupId)=>Array.from(document.querySelectorAll('.quick-add-input')).find(input=>input.dataset.listId===listId&&((input.dataset.groupId??'')===(groupId??'')));
const rememberQuickAddFocus=(listId,groupId)=>{const state=readState();writeState({...state,pendingQuickAdd:{listId,groupId:groupId??''}});};
const restoreQuickAddFocus=()=>{const state=readState();const pending=state.pendingQuickAdd;if(!pending){return;}const input=findQuickAddInput(pending.listId,pending.groupId);if(input instanceof HTMLInputElement){input.focus();input.select();}writeState({...state,pendingQuickAdd:undefined});};
document.getElementById('filter')?.addEventListener('input',event=>vscode.postMessage({type:'setFilter',value:event.target.value}));
document.addEventListener('click',event=>{const target=event.target.closest('[data-action]');if(!target){return;}const type=target.dataset.action;if(type==='toggleShellSection'){vscode.postMessage({type,shellId:target.dataset.shellId});return;}if(type==='toggleListExpanded'){vscode.postMessage({type,listId:target.dataset.listId,source:target.dataset.source});return;}if(type==='addGroup'||type==='addTodo'){event.stopPropagation();vscode.postMessage({type,listId:target.dataset.listId,groupId:target.dataset.groupId,source:target.dataset.source});return;}if(type==='quickAddTodo'){event.stopPropagation();const row=target.closest('.quick-add-row');const input=row?.querySelector('.quick-add-input');rememberQuickAddFocus(target.dataset.listId,target.dataset.groupId);vscode.postMessage({type,listId:target.dataset.listId,groupId:target.dataset.groupId,text:input?.value??'',source:target.dataset.source});if(input){input.value='';}return;}if(type==='shareCurrentList'||type==='copyShareKey'||type==='openListInEditor'){event.stopPropagation();vscode.postMessage({type,listId:target.dataset.listId,source:target.dataset.source});return;}if(type==='renameGroup'){event.stopPropagation();vscode.postMessage({type,listId:target.dataset.listId,groupId:target.dataset.groupId,source:target.dataset.source});return;}if(type==='toggleDone'||type==='deleteTodo'||type==='renameTodo'){event.stopPropagation();vscode.postMessage({type,listId:target.dataset.listId,todoId:target.dataset.todoId,source:target.dataset.source});return;}if(type==='deleteGroup'){event.stopPropagation();vscode.postMessage({type,listId:target.dataset.listId,groupId:target.dataset.groupId,source:target.dataset.source});return;}if(type==='deleteList'||type==='renameList'||type==='syncSharedList'){event.stopPropagation();vscode.postMessage({type,listId:target.dataset.listId,source:target.dataset.source});return;}vscode.postMessage({type});});
document.addEventListener('keydown',event=>{const input=event.target.closest('.quick-add-input');if(!input||event.key!=='Enter'){return;}event.preventDefault();rememberQuickAddFocus(input.dataset.listId,input.dataset.groupId);vscode.postMessage({type:'quickAddTodo',listId:input.dataset.listId,groupId:input.dataset.groupId,text:input.value,source:input.dataset.source});input.value='';});
document.querySelectorAll('[data-drop-list-id]').forEach(element=>{element.addEventListener('dragover',event=>{event.preventDefault();event.stopPropagation();element.classList.add('over');});element.addEventListener('dragleave',event=>{event.stopPropagation();element.classList.remove('over');});element.addEventListener('drop',event=>{event.preventDefault();event.stopPropagation();element.classList.remove('over');const raw=event.dataTransfer?.getData('application/x-todo-item');if(!raw){return;}const payload=JSON.parse(raw);if(payload.type==='todo'){vscode.postMessage({type:'moveTodo',sourceListId:payload.listId,todoId:payload.todoId,targetListId:element.dataset.dropListId,targetGroupId:element.dataset.dropGroupId,source:payload.source});return;}vscode.postMessage({type:'moveGroup',sourceListId:payload.listId,groupId:payload.groupId,targetListId:element.dataset.dropListId,targetGroupId:element.dataset.dropGroupId,source:payload.source});});});
document.querySelectorAll('.drag').forEach(element=>{element.addEventListener('dragstart',event=>{event.stopPropagation();event.dataTransfer?.setData('application/x-todo-item',JSON.stringify({type:element.dataset.dragType,listId:element.dataset.listId,todoId:element.dataset.todoId,groupId:element.dataset.groupId,source:element.dataset.source}));if(event.dataTransfer){event.dataTransfer.effectAllowed='move';}});});
restoreQuickAddFocus();
</script></body></html>`;
  }

  private buildRenderableLists(): RenderedList[] {
    const sharedLinkedListIds = new Set(this.sharedListsCache.map((record) => record.listId));
    const localLists = this.state.listLists().map<RenderedList>((list) => ({
      source: "local",
      id: list.id,
      displayId: list.id,
      name: list.name,
      createdAt: list.createdAt,
      store: list.store
    })).filter((list) => !sharedLinkedListIds.has(list.id));
    const sharedLists = this.sharedListsCache.map<RenderedList>((record) => ({
      source: "shared",
      id: record.id,
      displayId: record.id,
      name: record.listName,
      createdAt: record.snapshot.createdAt,
      store: record.snapshot.store,
      record,
      sharedBadge: `${record.target.owner}/${record.target.repo}`
    }));
    return [...localLists, ...sharedLists].sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name));
  }

  private renderListCard(list: RenderedList, isExpanded: boolean, filter: string): string {
    const groups = this.countVisibleGroups(list.store.groups, filter);
    const todos = this.countVisibleTodos(list.store, filter);
    const body = isExpanded
      ? `${this.sortTodosByCreatedAt(list.store.todos).filter((todo) => this.todoMatches(todo, filter)).map((todo) => this.renderTodoRow(list.displayId, list.source, todo)).join("")}${list.store.groups.map((group) => this.renderGroup(list.displayId, list.source, group, filter)).filter(Boolean).join("")}${this.renderQuickAddRow(list.displayId, list.source)}`
      : "";
    return `<article class="list-card ${list.source === "shared" ? "shared" : ""} ${isExpanded ? "expanded" : ""}"><div class="list-row drop-target" data-action="toggleListExpanded" data-list-id="${list.displayId}" data-source="${list.source}" data-drop-list-id="${list.displayId}"><span class="caret-list">${this.icon("chevron")}</span><div class="grow"><span class="label title" title="${this.escapeHtml(list.name)}">${this.escapeHtml(list.name)}</span>${list.sharedBadge ? `<button class="badge badge-icon action action-share" type="button" data-action="copyShareKey" data-list-id="${list.displayId}" data-source="${list.source}" title="Copy share key" aria-label="Copy share key">${this.icon("link")}</button>` : ""}</div><span class="list-stats" aria-label="${groups} folders and ${todos} tasks"><span class="stat-pill" title="${groups} folders">${this.icon("folder")}<span>${groups}</span></span><span class="stat-pill" title="${todos} tasks">${this.icon("task")}<span>${todos}</span></span></span><span class="actions">${list.source === "local" ? `<button class="action action-share" type="button" data-action="shareCurrentList" data-list-id="${list.displayId}" data-source="${list.source}" title="Share this list">${this.icon("link")}</button>` : `<button class="action action-share" type="button" data-action="copyShareKey" data-list-id="${list.displayId}" data-source="${list.source}" title="Copy share key">${this.icon("copy")}</button>`}<button class="action" type="button" data-action="addGroup" data-list-id="${list.displayId}" data-source="${list.source}" title="Add root folder">${this.icon("folderPlus")}</button><button class="action" type="button" data-action="renameList" data-list-id="${list.displayId}" data-source="${list.source}" title="Rename list">${this.icon("pencil")}</button><button class="action action-danger" type="button" data-action="deleteList" data-list-id="${list.displayId}" data-source="${list.source}" title="Delete list">${this.icon("trash")}</button></span></div>${isExpanded ? `<div class="content drop-target" data-drop-list-id="${list.displayId}" data-source="${list.source}">${body || '<div class="empty">No matching items.</div>'}</div>` : ""}</article>`;
  }

  private renderGroup(listId: ListId, source: ListSource, group: TodoGroup, filter: string): string {
    const groupMatches = !filter || group.name.toLowerCase().includes(filter.toLowerCase());
    const todos = this.sortTodosByCreatedAt(group.todos).filter((todo) => this.todoMatches(todo, filter)).map((todo) => this.renderTodoRow(listId, source, todo)).join("");
    const groups = group.groups.map((item) => this.renderGroup(listId, source, item, filter)).filter(Boolean).join("");
    if (!groupMatches && !todos && !groups) {
      return "";
    }
    return `<details class="group" open><summary class="group-summary drop-target" data-drop-list-id="${listId}" data-source="${source}" data-drop-group-id="${group.id}"><span class="details-caret">${this.icon("chevron")}</span><span class="grow label">${this.escapeHtml(group.name)}</span><span class="hover-tools"><button class="action" type="button" data-action="addTodo" data-list-id="${listId}" data-source="${source}" data-group-id="${group.id}" title="Quick add TODO">${this.icon("plus")}</button><button class="action" type="button" data-action="addGroup" data-list-id="${listId}" data-source="${source}" data-group-id="${group.id}" title="Add subgroup">${this.icon("folderPlus")}</button><button class="action" type="button" data-action="renameGroup" data-list-id="${listId}" data-source="${source}" data-group-id="${group.id}" title="Rename folder">${this.icon("pencil")}</button><button class="action drag" type="button" draggable="true" data-drag-type="group" data-list-id="${listId}" data-source="${source}" data-group-id="${group.id}" title="Drag group">${this.icon("drag")}</button><button class="action action-danger" type="button" data-action="deleteGroup" data-list-id="${listId}" data-source="${source}" data-group-id="${group.id}" title="Delete group">${this.icon("trash")}</button></span></summary><div class="group-body drop-target" data-drop-list-id="${listId}" data-source="${source}" data-drop-group-id="${group.id}">${todos}${groups || (todos ? "" : '<div class="empty">No items yet.</div>')}${this.renderQuickAddRow(listId, source, group.id)}</div></details>`;
  }

  private renderTodoRow(listId: ListId, source: ListSource, todo: TodoItem): string {
    const dateStr = new Date(todo.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const hoverDate = formatDate(todo.createdAt);
    return `<div class="todo-row"><button class="check ${todo.done ? "done" : ""}" type="button" data-action="toggleDone" data-list-id="${listId}" data-source="${source}" data-todo-id="${todo.id}" title="Toggle done"></button><div class="grow todo-main"><span class="label ${todo.done ? "done" : ""}" title="Created: ${dateStr}">${this.escapeHtml(todo.text)}</span><span class="todo-date" title="Created: ${dateStr}">${hoverDate}</span></div><span class="hover-tools"><button class="action" type="button" data-action="renameTodo" data-list-id="${listId}" data-source="${source}" data-todo-id="${todo.id}" title="Rename task">${this.icon("pencil")}</button><button class="action drag" type="button" draggable="true" data-drag-type="todo" data-list-id="${listId}" data-source="${source}" data-todo-id="${todo.id}" title="Drag TODO">${this.icon("drag")}</button><button class="action action-danger" type="button" data-action="deleteTodo" data-list-id="${listId}" data-source="${source}" data-todo-id="${todo.id}" title="Delete TODO">${this.icon("trash")}</button></span></div>`;
  }

  private renderQuickAddRow(listId: ListId, source: ListSource, groupId?: GroupId): string {
    return `<div class="quick-add-row ${groupId ? "" : "list-quick-add"}"><span class="settings-meta">${this.icon("plus")}</span><input class="quick-add-input" type="text" placeholder="Add task..." data-list-id="${listId}" data-source="${source}" ${groupId ? `data-group-id="${groupId}"` : ""} /><button class="action" type="button" data-action="quickAddTodo" data-list-id="${listId}" data-source="${source}" ${groupId ? `data-group-id="${groupId}"` : ""} title="Add task">${this.icon("plus")}</button></div>`;
  }

  private async cleanupExpiredCompletedTodos(): Promise<void> {
    const retentionMs = this.state.getCompletedRetentionDays() * 24 * 60 * 60 * 1000;
    const now = Date.now();
    for (const list of this.state.listLists()) {
      const store = this.cloneStore(list.store);
      if (this.cleanupStore(store, now, retentionMs)) {
        await this.state.updateList(list.id, (target) => {
          target.store = store;
        });
      }
    }
  }

  private async writeExportFile(lists: TodoList[], defaultFileName: string): Promise<void> {
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file("."), defaultFileName),
      filters: { JSON: ["json"] },
      saveLabel: "Export TODO data"
    });
    if (!uri) {
      return;
    }

    const payload: ExportPayload = {
      version: 2,
      exportedAt: new Date().toISOString(),
      entries: lists.map((list) => ({ list }))
    };
    await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(payload, null, 2), "utf8"));
    void vscode.window.showInformationMessage(`Exported ${lists.length} list${lists.length === 1 ? "" : "s"}.`);
  }

  private normalizeImportedLists(raw: unknown): TodoList[] {
    const parsed = raw as Partial<ExportPayload> & {
      entries?: Array<{ list?: Partial<TodoList>; label?: string; store?: Partial<TodoStore> }>;
    };
    const usedIds = new Set(this.state.listLists().map((list) => list.id));
    return ((parsed.entries ?? []) as Array<{ list?: Partial<TodoList>; label?: string; store?: Partial<TodoStore> }>)
      .map((entry, index) => {
        const list = entry.list;
        const idCandidate = typeof list?.id === "string" ? list.id : this.newId("imported");
        const id = usedIds.has(idCandidate) ? this.newId("imported") : idCandidate;
        usedIds.add(id);
        return {
          id,
          name:
            typeof list?.name === "string" && list.name.trim()
              ? list.name.trim()
              : typeof entry.label === "string" && entry.label.trim()
                ? entry.label.trim()
                : `Imported List ${index + 1}`,
          createdAt: typeof list?.createdAt === "number" ? list.createdAt : Date.now(),
          store: this.normalizeStore(list?.store ?? entry.store)
        };
      })
      .filter((list) => list.name.length > 0);
  }

  private normalizeStore(raw?: Partial<TodoStore>): TodoStore {
    return {
      groups: (raw?.groups ?? []).map((group) => ({
        id: group.id || this.newId("group"),
        name: group.name || "Untitled group",
        groups: this.normalizeStore({ groups: group.groups ?? [], todos: [] }).groups,
        todos: (group.todos ?? []).map((todo) => ({
          id: todo.id || this.newId("todo"),
          text: todo.text ?? "",
          done: Boolean(todo.done),
          createdAt: typeof todo.createdAt === "number" ? todo.createdAt : Date.now(),
          completedAt: typeof todo.completedAt === "number" ? todo.completedAt : undefined
        }))
      })),
      todos: (raw?.todos ?? []).map((todo) => ({
        id: todo.id || this.newId("todo"),
        text: todo.text ?? "",
        done: Boolean(todo.done),
        createdAt: typeof todo.createdAt === "number" ? todo.createdAt : Date.now(),
        completedAt: typeof todo.completedAt === "number" ? todo.completedAt : undefined
      }))
    };
  }

  private findGroupById(groups: TodoGroup[], groupId: GroupId): TodoGroup | undefined {
    for (const group of groups) {
      if (group.id === groupId) {
        return group;
      }
      const nested = this.findGroupById(group.groups, groupId);
      if (nested) {
        return nested;
      }
    }
    return undefined;
  }

  private findTodo(store: TodoStore, todoId: TodoId): TodoItem | undefined {
    const root = store.todos.find((todo) => todo.id === todoId);
    if (root) {
      return root;
    }
    const visit = (groups: TodoGroup[]): TodoItem | undefined => {
      for (const group of groups) {
        const todo = group.todos.find((item) => item.id === todoId);
        if (todo) {
          return todo;
        }
        const nested = visit(group.groups);
        if (nested) {
          return nested;
        }
      }
      return undefined;
    };
    return visit(store.groups);
  }

  private removeTodo(store: TodoStore, todoId: TodoId): TodoItem | undefined {
    const rootIndex = store.todos.findIndex((todo) => todo.id === todoId);
    if (rootIndex >= 0) {
      return store.todos.splice(rootIndex, 1)[0];
    }
    const visit = (groups: TodoGroup[]): TodoItem | undefined => {
      for (const group of groups) {
        const index = group.todos.findIndex((todo) => todo.id === todoId);
        if (index >= 0) {
          return group.todos.splice(index, 1)[0];
        }
        const nested = visit(group.groups);
        if (nested) {
          return nested;
        }
      }
      return undefined;
    };
    return visit(store.groups);
  }

  private removeGroup(groups: TodoGroup[], groupId: GroupId): TodoGroup | undefined {
    const index = groups.findIndex((group) => group.id === groupId);
    if (index >= 0) {
      return groups.splice(index, 1)[0];
    }
    for (const group of groups) {
      const nested = this.removeGroup(group.groups, groupId);
      if (nested) {
        return nested;
      }
    }
    return undefined;
  }

  private countVisibleTodos(store: TodoStore, filter: string): number {
    const lowered = filter.toLowerCase();
    let count = store.todos.filter((todo) => todo.text.toLowerCase().includes(lowered)).length;
    const visit = (groups: TodoGroup[]): void => {
      for (const group of groups) {
        count += group.todos.filter((todo) => todo.text.toLowerCase().includes(lowered)).length;
        visit(group.groups);
      }
    };
    visit(store.groups);
    return filter ? count : store.todos.length + this.countNestedTodos(store.groups);
  }

  private countNestedTodos(groups: TodoGroup[]): number {
    return groups.reduce((sum, group) => sum + group.todos.length + this.countNestedTodos(group.groups), 0);
  }

  private countVisibleGroups(groups: TodoGroup[], filter: string): number {
    const lowered = filter.toLowerCase();
    let count = 0;
    const visit = (items: TodoGroup[]): boolean => {
      let any = false;
      for (const group of items) {
        const childVisible = visit(group.groups);
        const todoVisible = group.todos.some((todo) => !filter || todo.text.toLowerCase().includes(lowered));
        const groupVisible = !filter || group.name.toLowerCase().includes(lowered) || childVisible || todoVisible;
        if (groupVisible) {
          count += 1;
          any = true;
        }
      }
      return any;
    };
    visit(groups);
    return count;
  }

  private cleanupStore(store: TodoStore, now: number, retentionMs: number): boolean {
    let changed = false;
    store.todos = store.todos.filter((todo) => {
      const keep = !todo.done || !todo.completedAt || now - todo.completedAt < retentionMs;
      if (!keep) {
        changed = true;
      }
      return keep;
    });
    const visit = (groups: TodoGroup[]): void => {
      for (const group of groups) {
        group.todos = group.todos.filter((todo) => {
          const keep = !todo.done || !todo.completedAt || now - todo.completedAt < retentionMs;
          if (!keep) {
            changed = true;
          }
          return keep;
        });
        visit(group.groups);
      }
    };
    visit(store.groups);
    return changed;
  }

  private cloneStore(store: TodoStore): TodoStore {
    return JSON.parse(JSON.stringify(store)) as TodoStore;
  }

  private insertTodo(store: TodoStore, todo: TodoItem, targetGroupId?: GroupId): boolean {
    if (!targetGroupId) {
      store.todos.push(todo);
      return true;
    }
    const group = this.findGroupById(store.groups, targetGroupId);
    if (!group) {
      return false;
    }
    group.todos.push(todo);
    return true;
  }

  private insertGroup(groups: TodoGroup[], group: TodoGroup, targetGroupId?: GroupId): boolean {
    if (!targetGroupId) {
      groups.push(group);
      return true;
    }
    const target = this.findGroupById(groups, targetGroupId);
    if (!target) {
      return false;
    }
    target.groups.push(group);
    return true;
  }

  private containsGroup(root: TodoGroup, targetGroupId?: GroupId): boolean {
    if (!targetGroupId) {
      return false;
    }
    return root.groups.some((group) => group.id === targetGroupId || this.containsGroup(group, targetGroupId));
  }

  private sortTodosByCreatedAt(todos: TodoItem[]): TodoItem[] {
    return todos
      .map((todo, index) => ({ todo, index }))
      .sort((a, b) => a.todo.createdAt - b.todo.createdAt || a.index - b.index)
      .map(({ todo }) => todo);
  }

  private todoMatches(todo: TodoItem, filter: string): boolean {
    return !filter || todo.text.toLowerCase().includes(filter.toLowerCase());
  }

  private newId(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  private slugify(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "todo-list";
  }

  private icon(name: "plus" | "folderPlus" | "folder" | "task" | "pencil" | "trash" | "export" | "import" | "drag" | "settings" | "clear" | "check" | "chevron" | "refresh" | "link" | "copy"): string {
    const icons: Record<string, string> = {
      plus: "add",
      folderPlus: "new-folder",
      folder: "folder",
      task: "checklist",
      pencil: "edit",
      trash: "trash",
      export: "export",
      import: "cloud-upload",
      drag: "gripper",
      settings: "settings-gear",
      clear: "close",
      check: "check",
      chevron: "chevron-right",
      refresh: "refresh",
      link: "link",
      copy: "copy"
    };
    return `<span class="icon codicon codicon-${icons[name]}" aria-hidden="true"></span>`;
  }

  private escapeHtml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat("cs-CZ", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(new Date(timestamp));
}

export function activate(context: vscode.ExtensionContext): void {
  storageManager.initialize(context);

  const state = new TodoState(context);
  const controller = new TodoController(state, context.extensionUri);

  const pickList = async (): Promise<TodoList | undefined> => {
    await state.ensureInitialized();
    const lists = state.listLists();
    if (lists.length === 0) {
      void vscode.window.showInformationMessage("Create a list first.");
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      lists.map((list) => ({ label: list.name, description: `${list.store.groups.length} groups`, list })),
      { title: "Select list" }
    );
    return picked?.list;
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("todoListProView", controller),
    vscode.commands.registerCommand("todoListPro.createList", async () => controller.addList()),
    vscode.commands.registerCommand("todoListPro.shareCurrentList", async () => controller.shareCurrentList()),
    vscode.commands.registerCommand("todoListPro.openListInEditor", async () => {
      const list = await pickList();
      if (list) {
        await controller.openListInEditor(list.id, "local");
      }
    }),
    vscode.commands.registerCommand("todoListPro.addSharedList", async () => controller.addSharedList()),
    vscode.commands.registerCommand("todoListPro.copyLocalListToShareMode", async () => controller.copyLocalListToShareMode()),
    vscode.commands.registerCommand("todoListPro.syncSharedList", async () => controller.syncSharedList()),
    vscode.commands.registerCommand("todoListPro.addGroup", async () => {
      const list = await pickList();
      if (list) {
        await controller.addGroup(list.id);
      }
    }),
    vscode.commands.registerCommand("todoListPro.addTodo", async () => {
      const list = await pickList();
      if (list) {
        await controller.addTodo(list.id);
      }
    }),
    vscode.commands.registerCommand("todoListPro.importAll", async () => controller.importData()),
    vscode.commands.registerCommand("todoListPro.exportAll", async () => controller.exportAll()),
    vscode.commands.registerCommand("todoListPro.exportSingleList", async () => controller.exportSingleList()),
    vscode.commands.registerCommand("todoListPro.configureStorageMode", async () => {
      await controller.configureStorageMode();
    }),
    vscode.commands.registerCommand("todoListPro.configureWorkspaceVisibility", async () => {
      await controller.configureWorkspaceVisibility();
    }),
    vscode.commands.registerCommand("todoListPro.configureCompletedRetention", async () => {
      await controller.configureCompletedRetention();
    }),
    vscode.commands.registerCommand("todoListPro.toggleAutoRefreshSharedLists", async () => {
      await controller.toggleAutoRefreshSharedLists();
    }),
    vscode.commands.registerCommand("todoListPro.setFilter", async () => {
      const value = await vscode.window.showInputBox({ prompt: "Filter TODOs and folders" });
      if (typeof value === "string") {
        await controller.setFilter(value);
      }
    }),
    vscode.commands.registerCommand("todoListPro.clearFilter", async () => controller.clearFilter()),
    vscode.commands.registerCommand("todoListPro.refresh", async () => controller.refresh())
  );
}

export function deactivate(): void {
  // no-op
}
