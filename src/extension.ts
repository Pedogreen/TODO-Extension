import * as vscode from "vscode";

type StorageMode = "workspace" | "profile";
type ViewMode = "all" | "workspace";
type StoreTargetId = string;

interface TodoItem {
  id: string;
  text: string;
  done: boolean;
  createdAt: number;
  completedAt?: number;
}

interface TodoGroup {
  id: string;
  name: string;
  groups: TodoGroup[];
  todos: TodoItem[];
}

interface TodoStore {
  groups: TodoGroup[];
  hideCompleted: boolean;
  expandGroups: boolean;
  sectionCollapsed: boolean;
  collapsedGroupIds: string[];
}

interface SharedScope {
  id: string;
  name: string;
  createdAt: number;
}

interface ScopeRegistry {
  scopes: SharedScope[];
  links: Record<string, string>;
  stores: Record<string, TodoStore>;
}

interface ListTarget {
  id: StoreTargetId;
  label: string;
  description: string;
}

interface ShellState {
  main: boolean;
  lists: boolean;
  viewList: boolean;
  transfer: boolean;
}

interface ExportEntry {
  targetId: StoreTargetId;
  label: string;
  store: TodoStore;
}

interface ExportPayload {
  version: 1;
  exportedAt: string;
  entries: ExportEntry[];
}

type WebviewAction =
  | { type: "setFilter"; value: string }
  | { type: "clearFilter" }
  | { type: "addRootGroup"; mode?: StorageMode; targetId?: StoreTargetId }
  | { type: "addSubgroup"; mode?: StorageMode; targetId?: StoreTargetId; groupId: string }
  | { type: "addTodo"; mode?: StorageMode; targetId?: StoreTargetId; groupId?: string }
  | { type: "toggleDone"; mode?: StorageMode; targetId?: StoreTargetId; todoId: string }
  | { type: "deleteGroup"; mode?: StorageMode; targetId?: StoreTargetId; groupId: string }
  | { type: "deleteTodo"; mode?: StorageMode; targetId?: StoreTargetId; todoId: string }
  | { type: "setExpandAll" }
  | { type: "setCollapseAll" }
  | { type: "setSectionExpand"; mode?: StorageMode; targetId?: StoreTargetId; expand: boolean }
  | { type: "toggleSectionCollapsed"; mode?: StorageMode; targetId?: StoreTargetId }
  | { type: "toggleGroupCardCollapsed"; mode?: StorageMode; targetId?: StoreTargetId; groupId: string }
  | { type: "toggleHideCompleted"; mode?: StorageMode; targetId?: StoreTargetId }
  | { type: "setViewMode"; viewMode: ViewMode }
  | { type: "createWorkspaceLink" }
  | { type: "linkWorkspaceToScope" }
  | { type: "unlinkWorkspaceScope" }
  | { type: "selectTarget"; targetId: StoreTargetId }
  | { type: "toggleShellSection"; shellId: "main" | "lists" | "viewList" | "transfer" }
  | { type: "exportAll" }
  | { type: "exportTarget"; targetId: StoreTargetId }
  | { type: "importData"; targetId?: StoreTargetId }
  | { type: "clearTarget"; targetId: StoreTargetId }
  | { type: "deleteTarget"; targetId: StoreTargetId }
  | { type: "moveTargetToGroup"; sourceTargetId: StoreTargetId; targetId: StoreTargetId; groupId: string }
  | { type: "refresh" };

class TodoState {
  private static readonly WORKSPACE_KEY = "todoListPro.store.workspace";
  private static readonly PROFILE_KEY = "todoListPro.store.profile";
  private static readonly FILTER_KEY = "todoListPro.ui.filter";
  private static readonly VIEW_MODE_KEY = "todoListPro.ui.viewMode";
  private static readonly SELECTED_TARGET_KEY = "todoListPro.ui.selectedTarget";
  private static readonly SHELL_STATE_KEY = "todoListPro.ui.shellState";
  private static readonly SCOPE_REGISTRY_KEY = "todoListPro.workspaceScopes";
  private readonly context: vscode.ExtensionContext;

  public constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.context.globalState.setKeysForSync([TodoState.PROFILE_KEY, TodoState.SCOPE_REGISTRY_KEY]);
  }

  public readStore(mode: StorageMode): TodoStore {
    const raw =
      mode === "workspace"
        ? this.readWorkspaceStore()
        : this.context.globalState.get<TodoStore | undefined>(TodoState.PROFILE_KEY);
    const hideDefault = vscode.workspace
      .getConfiguration("todoListPro")
      .get<boolean>("hideCompletedByDefault", false);

    if (!raw) {
      return {
        groups: [],
        hideCompleted: hideDefault,
        expandGroups: true,
        sectionCollapsed: false,
        collapsedGroupIds: []
      };
    }

    return {
      groups: raw.groups ?? [],
      hideCompleted: raw.hideCompleted ?? hideDefault,
      expandGroups: raw.expandGroups ?? true,
      sectionCollapsed: raw.sectionCollapsed ?? false,
      collapsedGroupIds: raw.collapsedGroupIds ?? []
    };
  }

  public async writeStore(mode: StorageMode, store: TodoStore): Promise<void> {
    if (mode === "workspace") {
      await this.writeWorkspaceStore(store);
      return;
    }
    await this.context.globalState.update(TodoState.PROFILE_KEY, store);
  }

  public readFilter(): string {
    return this.context.workspaceState.get<string>(TodoState.FILTER_KEY, "");
  }

  public async setFilter(value: string): Promise<void> {
    await this.context.workspaceState.update(TodoState.FILTER_KEY, value.trim());
  }

  public readViewMode(): ViewMode {
    return this.context.workspaceState.get<ViewMode>(TodoState.VIEW_MODE_KEY, "all");
  }

  public async setViewMode(viewMode: ViewMode): Promise<void> {
    await this.context.workspaceState.update(TodoState.VIEW_MODE_KEY, viewMode);
  }

  public readSelectedTarget(): StoreTargetId {
    return this.context.workspaceState.get<StoreTargetId>(TodoState.SELECTED_TARGET_KEY, "workspace");
  }

  public async setSelectedTarget(targetId: StoreTargetId): Promise<void> {
    await this.context.workspaceState.update(TodoState.SELECTED_TARGET_KEY, targetId);
  }

  public readShellState(): ShellState {
    const raw = this.context.workspaceState.get<Partial<ShellState> | undefined>(TodoState.SHELL_STATE_KEY);
    return {
      main: raw?.main ?? true,
      lists: raw?.lists ?? false,
      viewList: raw?.viewList ?? false,
      transfer: raw?.transfer ?? false
    };
  }

  public async setShellState(shellState: ShellState): Promise<void> {
    await this.context.workspaceState.update(TodoState.SHELL_STATE_KEY, shellState);
  }

  public getWorkspaceScope(): SharedScope | undefined {
    const registry = this.readScopeRegistry();
    const scopeId = registry.links[this.getWorkspaceFingerprint()];
    if (!scopeId) {
      return undefined;
    }
    return registry.scopes.find((scope) => scope.id === scopeId);
  }

  public listWorkspaceScopes(): SharedScope[] {
    return [...this.readScopeRegistry().scopes].sort((a, b) => a.name.localeCompare(b.name));
  }

  public listTargets(): ListTarget[] {
    const currentScope = this.getWorkspaceScope();
    const scopeTargets = this.listWorkspaceScopes().map((scope) => ({
      id: `scope:${scope.id}`,
      label: scope.name,
      description: currentScope?.id === scope.id ? "shared current workspace" : "shared workspace project"
    }));

    return [
      { id: "workspace", label: "Current Workspace", description: currentScope ? `linked to ${currentScope.name}` : "local workspace" },
      { id: "profile", label: "Profile", description: "global synced TODOs" },
      ...scopeTargets
    ];
  }

  public readTargetStore(targetId: StoreTargetId): TodoStore {
    if (targetId === "workspace") {
      return this.readStore("workspace");
    }
    if (targetId === "profile") {
      return this.readStore("profile");
    }
    if (targetId.startsWith("scope:")) {
      const scopeId = targetId.slice("scope:".length);
      const registry = this.readScopeRegistry();
      const raw = registry.stores[scopeId];
      const hideDefault = vscode.workspace
        .getConfiguration("todoListPro")
        .get<boolean>("hideCompletedByDefault", false);

      return {
        groups: raw?.groups ?? [],
        hideCompleted: raw?.hideCompleted ?? hideDefault,
        expandGroups: raw?.expandGroups ?? true,
        sectionCollapsed: raw?.sectionCollapsed ?? false,
        collapsedGroupIds: raw?.collapsedGroupIds ?? []
      };
    }

    return this.readStore("workspace");
  }

  public async writeTargetStore(targetId: StoreTargetId, store: TodoStore): Promise<void> {
    if (targetId === "workspace") {
      await this.writeStore("workspace", store);
      return;
    }
    if (targetId === "profile") {
      await this.writeStore("profile", store);
      return;
    }
    if (targetId.startsWith("scope:")) {
      const scopeId = targetId.slice("scope:".length);
      const registry = this.readScopeRegistry();
      registry.stores[scopeId] = store;
      await this.writeScopeRegistry(registry);
      return;
    }
  }

  public async createWorkspaceScope(name: string): Promise<SharedScope> {
    const registry = this.readScopeRegistry();
    const scope: SharedScope = {
      id: this.newId("scope"),
      name: name.trim(),
      createdAt: Date.now()
    };
    registry.scopes.push(scope);
    registry.stores[scope.id] = this.readStore("workspace");
    registry.links[this.getWorkspaceFingerprint()] = scope.id;
    await this.writeScopeRegistry(registry);
    return scope;
  }

  public async linkWorkspaceToScope(scopeId: string): Promise<void> {
    const registry = this.readScopeRegistry();
    const scope = registry.scopes.find((item) => item.id === scopeId);
    if (!scope) {
      return;
    }

    if (!registry.stores[scopeId]) {
      registry.stores[scopeId] = this.readStore("workspace");
    }

    registry.links[this.getWorkspaceFingerprint()] = scopeId;
    await this.writeScopeRegistry(registry);
  }

  public async unlinkWorkspaceScope(): Promise<void> {
    const registry = this.readScopeRegistry();
    const currentStore = this.readStore("workspace");
    await this.context.workspaceState.update(TodoState.WORKSPACE_KEY, currentStore);
    delete registry.links[this.getWorkspaceFingerprint()];
    await this.writeScopeRegistry(registry);
  }

  public async ensureImportTarget(targetId: StoreTargetId, label: string): Promise<StoreTargetId> {
    if (targetId === "workspace" || targetId === "profile") {
      return targetId;
    }

    if (targetId.startsWith("scope:")) {
      const scopeId = targetId.slice("scope:".length);
      const registry = this.readScopeRegistry();
      const existing = registry.scopes.find((scope) => scope.id === scopeId);
      if (existing) {
        return targetId;
      }

      registry.scopes.push({
        id: scopeId,
        name: label,
        createdAt: Date.now()
      });
      if (!registry.stores[scopeId]) {
        registry.stores[scopeId] = this.readStore("workspace");
      }
      await this.writeScopeRegistry(registry);
      return targetId;
    }

    return "workspace";
  }

  public async deleteTarget(targetId: StoreTargetId): Promise<boolean> {
    if (!targetId.startsWith("scope:")) {
      return false;
    }

    const scopeId = targetId.slice("scope:".length);
    const registry = this.readScopeRegistry();
    const exists = registry.scopes.some((scope) => scope.id === scopeId);
    if (!exists) {
      return false;
    }

    registry.scopes = registry.scopes.filter((scope) => scope.id !== scopeId);
    delete registry.stores[scopeId];
    for (const [fingerprint, linkedScopeId] of Object.entries(registry.links)) {
      if (linkedScopeId === scopeId) {
        delete registry.links[fingerprint];
      }
    }

    await this.writeScopeRegistry(registry);
    return true;
  }

  private readWorkspaceStore(): TodoStore | undefined {
    const scope = this.getWorkspaceScope();
    if (!scope) {
      return this.readLocalWorkspaceStore();
    }
    const registry = this.readScopeRegistry();
    return registry.stores[scope.id];
  }

  private async writeWorkspaceStore(store: TodoStore): Promise<void> {
    const scope = this.getWorkspaceScope();
    if (!scope) {
      await this.context.workspaceState.update(TodoState.WORKSPACE_KEY, store);
      return;
    }

    const registry = this.readScopeRegistry();
    registry.stores[scope.id] = store;
    await this.writeScopeRegistry(registry);
  }

  private readLocalWorkspaceStore(): TodoStore | undefined {
    return this.context.workspaceState.get<TodoStore | undefined>(TodoState.WORKSPACE_KEY);
  }

  private readScopeRegistry(): ScopeRegistry {
    const raw = this.context.globalState.get<ScopeRegistry | undefined>(TodoState.SCOPE_REGISTRY_KEY);
    if (!raw) {
      return { scopes: [], links: {}, stores: {} };
    }
    return {
      scopes: raw.scopes ?? [],
      links: raw.links ?? {},
      stores: raw.stores ?? {}
    };
  }

  private async writeScopeRegistry(registry: ScopeRegistry): Promise<void> {
    await this.context.globalState.update(TodoState.SCOPE_REGISTRY_KEY, registry);
  }

  private getWorkspaceFingerprint(): string {
    const folders = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.toString()).sort() ?? [];
    if (folders.length > 0) {
      return folders.join("|");
    }
    const workspaceFile = vscode.workspace.workspaceFile?.toString();
    return workspaceFile ?? "empty-window";
  }

  private newId(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

class TodoController implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  public constructor(private readonly state: TodoState) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.onDidReceiveMessage(async (message: WebviewAction) => {
      await this.handleAction(message);
    });
    void this.refresh();
  }

  public async refresh(): Promise<void> {
    await this.cleanupExpiredCompletedTodos("workspace");
    await this.cleanupExpiredCompletedTodos("profile");

    if (!this.view) {
      return;
    }
    this.view.webview.html = this.renderHtml();
  }

  public async setFilter(filter: string): Promise<void> {
    const next = filter.trim();
    if (this.state.readFilter() === next) {
      return;
    }
    await this.state.setFilter(next);
    await this.refresh();
  }

  public async clearFilter(): Promise<void> {
    await this.setFilter("");
  }

  public async addGroup(targetId: StoreTargetId, parentGroupId?: string): Promise<void> {
    const parent = parentGroupId ? this.findGroupById(this.state.readTargetStore(targetId).groups, parentGroupId) : undefined;
    const name = await vscode.window.showInputBox({
      prompt: parent ? `Subgroup name in "${parent.name}"` : "Group name",
      placeHolder: "e.g. Backend"
    });
    if (!name?.trim()) {
      return;
    }

    const store = this.state.readTargetStore(targetId);
    const target = parentGroupId ? this.findGroupById(store.groups, parentGroupId) : undefined;
    const newGroup: TodoGroup = {
      id: this.newId(),
      name: name.trim(),
      groups: [],
      todos: []
    };

    if (target) {
      target.groups.push(newGroup);
    } else {
      store.groups.push(newGroup);
    }

    await this.state.writeTargetStore(targetId, store);
    await this.refresh();
  }

  public async addTodo(targetId: StoreTargetId, groupId?: string): Promise<void> {
    const store = this.state.readTargetStore(targetId);
    let group: TodoGroup | undefined;

    if (groupId) {
      group = this.findGroupById(store.groups, groupId);
    } else {
      const candidates = this.flattenGroups(store.groups);
      if (candidates.length === 0) {
        vscode.window.showInformationMessage("Create a group first.");
        return;
      }

      const picked = await vscode.window.showQuickPick(
        candidates.map((g) => ({ label: g.name, description: g.id })),
        { title: "Select group for TODO" }
      );
      if (!picked?.description) {
        return;
      }
      group = this.findGroupById(store.groups, picked.description);
    }

    if (!group) {
      return;
    }

    const text = await vscode.window.showInputBox({
      prompt: `TODO text in "${group.name}"`,
      placeHolder: "e.g. Add API validation"
    });
    if (!text?.trim()) {
      return;
    }

    group.todos.push({
      id: this.newId(),
      text: text.trim(),
      done: false,
      createdAt: Date.now()
    });

    await this.state.writeTargetStore(targetId, store);
    await this.refresh();
  }

  public async toggleDone(targetId: StoreTargetId, todoId: string): Promise<void> {
    const store = this.state.readTargetStore(targetId);
    const todoRef = this.findTodoRef(store.groups, todoId);
    if (!todoRef) {
      return;
    }

    todoRef.todo.done = !todoRef.todo.done;
    todoRef.todo.completedAt = todoRef.todo.done ? Date.now() : undefined;
    await this.state.writeTargetStore(targetId, store);
    await this.refresh();
  }

  public async deleteGroup(targetId: StoreTargetId, groupId: string): Promise<void> {
    const store = this.state.readTargetStore(targetId);
    const removed = this.deleteGroupById(store.groups, groupId);
    if (!removed) {
      return;
    }

    await this.state.writeTargetStore(targetId, store);
    await this.refresh();
  }

  public async deleteTodo(targetId: StoreTargetId, todoId: string): Promise<void> {
    const store = this.state.readTargetStore(targetId);
    const removed = this.deleteTodoById(store.groups, todoId);
    if (!removed) {
      return;
    }

    await this.state.writeTargetStore(targetId, store);
    await this.refresh();
  }

  public async setGroupExpansion(targetId: StoreTargetId, expandGroups: boolean): Promise<void> {
    const store = this.state.readTargetStore(targetId);
    store.expandGroups = expandGroups;
    await this.state.writeTargetStore(targetId, store);
    await this.refresh();
  }

  public async setExpandAll(expand: boolean): Promise<void> {
    const ws = this.state.readStore("workspace");
    ws.expandGroups = expand;
    await this.state.writeStore("workspace", ws);

    const profile = this.state.readStore("profile");
    profile.expandGroups = expand;
    await this.state.writeStore("profile", profile);

    await this.refresh();
  }

  public async toggleHideCompleted(targetId: StoreTargetId): Promise<void> {
    const store = this.state.readTargetStore(targetId);
    store.hideCompleted = !store.hideCompleted;
    await this.state.writeTargetStore(targetId, store);
    await this.refresh();
  }

  public async toggleSectionCollapsed(targetId: StoreTargetId): Promise<void> {
    const store = this.state.readTargetStore(targetId);
    store.sectionCollapsed = !store.sectionCollapsed;
    await this.state.writeTargetStore(targetId, store);
    await this.refresh();
  }

  public async toggleGroupCardCollapsed(targetId: StoreTargetId, groupId: string): Promise<void> {
    const store = this.state.readTargetStore(targetId);
    if (store.collapsedGroupIds.includes(groupId)) {
      store.collapsedGroupIds = store.collapsedGroupIds.filter((id) => id !== groupId);
    } else {
      store.collapsedGroupIds = [...store.collapsedGroupIds, groupId];
    }
    await this.state.writeTargetStore(targetId, store);
    await this.refresh();
  }

  public async setViewMode(viewMode: ViewMode): Promise<void> {
    if (this.state.readViewMode() === viewMode) {
      return;
    }
    await this.state.setViewMode(viewMode);
    await this.refresh();
  }

  public async createWorkspaceLink(): Promise<void> {
    const name = await vscode.window.showInputBox({
      prompt: "Shared project name",
      placeHolder: "e.g. CRM Backend"
    });
    if (!name?.trim()) {
      return;
    }
    await this.state.createWorkspaceScope(name);
    await this.refresh();
  }

  public async linkWorkspaceToExistingScope(): Promise<void> {
    const scopes = this.state.listWorkspaceScopes();
    if (scopes.length === 0) {
      vscode.window.showInformationMessage("No shared workspace projects exist yet.");
      return;
    }

    const picked = await vscode.window.showQuickPick(
      scopes.map((scope) => ({ label: scope.name, description: scope.id })),
      { title: "Link workspace to shared project" }
    );
    if (!picked?.description) {
      return;
    }

    await this.state.linkWorkspaceToScope(picked.description);
    await this.refresh();
  }

  public async unlinkWorkspaceScope(): Promise<void> {
    await this.state.unlinkWorkspaceScope();
    await this.refresh();
  }

  public async exportAll(): Promise<void> {
    const entries: ExportEntry[] = this.state.listTargets().map((target) => ({
      targetId: target.id,
      label: target.label,
      store: this.state.readTargetStore(target.id)
    }));
    await this.writeExportFile(entries, "todo-list-pro-all.json");
  }

  public async exportTarget(targetId: StoreTargetId): Promise<void> {
    const target = this.state.listTargets().find((item) => item.id === targetId);
    const entries: ExportEntry[] = [
      {
        targetId,
        label: target?.label ?? targetId,
        store: this.state.readTargetStore(targetId)
      }
    ];
    await this.writeExportFile(entries, `todo-list-pro-${this.slugify(target?.label ?? targetId)}.json`);
  }

  public async importData(targetId?: StoreTargetId): Promise<void> {
    const [source] =
      (await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { JSON: ["json"] },
        openLabel: "Import TODO data"
      })) ?? [];
    if (!source) {
      return;
    }

    try {
      const bytes = await vscode.workspace.fs.readFile(source);
      const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as Partial<ExportPayload>;
      const entries = Array.isArray(parsed.entries) ? parsed.entries : [];

      if (parsed.version !== 1 || entries.length === 0) {
        throw new Error("Invalid import format.");
      }

      if (targetId && entries.length === 1) {
        await this.state.writeTargetStore(targetId, this.normalizeStore(entries[0].store));
      } else {
        for (const entry of entries) {
          const resolvedTargetId = await this.state.ensureImportTarget(entry.targetId, entry.label);
          await this.state.writeTargetStore(resolvedTargetId, this.normalizeStore(entry.store));
        }
      }

      await this.refresh();
      void vscode.window.showInformationMessage(`Imported ${entries.length} list${entries.length === 1 ? "" : "s"}.`);
    } catch (error) {
      void vscode.window.showErrorMessage(`Import failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }

  public async clearTarget(targetId: StoreTargetId): Promise<void> {
    const target = this.state.listTargets().find((item) => item.id === targetId);
    const confirmed = await vscode.window.showWarningMessage(
      `Clear all groups and TODOs from "${target?.label ?? targetId}"?`,
      { modal: true },
      "Clear"
    );
    if (confirmed !== "Clear") {
      return;
    }

    const store = this.state.readTargetStore(targetId);
    store.groups = [];
    store.collapsedGroupIds = [];
    await this.state.writeTargetStore(targetId, store);
    await this.refresh();
  }

  public async deleteTarget(targetId: StoreTargetId): Promise<void> {
    const target = this.state.listTargets().find((item) => item.id === targetId);
    if (!target) {
      return;
    }

    if (!targetId.startsWith("scope:")) {
      await this.clearTarget(targetId);
      return;
    }

    const confirmed = await vscode.window.showWarningMessage(
      `Delete list "${target.label}" completely?`,
      { modal: true },
      "Delete"
    );
    if (confirmed !== "Delete") {
      return;
    }

    const removed = await this.state.deleteTarget(targetId);
    if (!removed) {
      return;
    }

    if (this.state.readSelectedTarget() === targetId) {
      await this.state.setSelectedTarget("workspace");
    }

    await this.refresh();
  }

  public async moveTargetToGroup(sourceTargetId: StoreTargetId, targetId: StoreTargetId, groupId: string): Promise<void> {
    if (sourceTargetId === targetId) {
      void vscode.window.showInformationMessage("Move between different lists only.");
      return;
    }

    const sourceTarget = this.state.listTargets().find((item) => item.id === sourceTargetId);
    if (!sourceTarget) {
      return;
    }

    const sourceStore = this.state.readTargetStore(sourceTargetId);
    if (sourceStore.groups.length === 0) {
      void vscode.window.showInformationMessage(`List "${sourceTarget.label}" is empty.`);
      return;
    }

    const targetStore = this.state.readTargetStore(targetId);
    const targetGroup = this.findGroupById(targetStore.groups, groupId);
    if (!targetGroup) {
      return;
    }

    const movedGroup: TodoGroup = {
      id: this.newId(),
      name: sourceTarget.label,
      groups: sourceStore.groups,
      todos: []
    };

    targetGroup.groups.push(movedGroup);
    await this.state.writeTargetStore(targetId, targetStore);

    if (sourceTargetId.startsWith("scope:")) {
      await this.state.deleteTarget(sourceTargetId);
      if (this.state.readSelectedTarget() === sourceTargetId) {
        await this.state.setSelectedTarget(targetId);
      }
    } else {
      const emptiedSource = this.state.readTargetStore(sourceTargetId);
      emptiedSource.groups = [];
      emptiedSource.collapsedGroupIds = [];
      await this.state.writeTargetStore(sourceTargetId, emptiedSource);
    }

    await this.refresh();
  }

  public async toggleShellSection(shellId: "main" | "lists" | "viewList" | "transfer"): Promise<void> {
    const shellState = this.state.readShellState();
    shellState[shellId] = !shellState[shellId];
    await this.state.setShellState(shellState);
    await this.refresh();
  }

  private async handleAction(action: WebviewAction): Promise<void> {
    const targetId = "targetId" in action && action.targetId ? action.targetId : ("mode" in action ? action.mode : undefined);

    switch (action.type) {
      case "setFilter":
        await this.setFilter(action.value);
        return;
      case "clearFilter":
        await this.clearFilter();
        return;
      case "addRootGroup":
        if (targetId) {
          await this.addGroup(targetId);
        }
        return;
      case "addSubgroup":
        if (targetId) {
          await this.addGroup(targetId, action.groupId);
        }
        return;
      case "addTodo":
        if (targetId) {
          await this.addTodo(targetId, action.groupId);
        }
        return;
      case "toggleDone":
        if (targetId) {
          await this.toggleDone(targetId, action.todoId);
        }
        return;
      case "deleteGroup":
        if (targetId) {
          await this.deleteGroup(targetId, action.groupId);
        }
        return;
      case "deleteTodo":
        if (targetId) {
          await this.deleteTodo(targetId, action.todoId);
        }
        return;
      case "setExpandAll":
        await this.setExpandAll(true);
        return;
      case "setCollapseAll":
        await this.setExpandAll(false);
        return;
      case "setSectionExpand":
        if (targetId) {
          await this.setGroupExpansion(targetId, action.expand);
        }
        return;
      case "toggleSectionCollapsed":
        if (targetId) {
          await this.toggleSectionCollapsed(targetId);
        }
        return;
      case "toggleGroupCardCollapsed":
        if (targetId) {
          await this.toggleGroupCardCollapsed(targetId, action.groupId);
        }
        return;
      case "toggleHideCompleted":
        if (targetId) {
          await this.toggleHideCompleted(targetId);
        }
        return;
      case "setViewMode":
        await this.setViewMode(action.viewMode);
        return;
      case "selectTarget":
        await this.state.setSelectedTarget(action.targetId);
        await this.state.setShellState({
          ...this.state.readShellState(),
          viewList: true
        });
        await this.refresh();
        return;
      case "toggleShellSection":
        await this.toggleShellSection(action.shellId);
        return;
      case "exportAll":
        await this.exportAll();
        return;
      case "exportTarget":
        await this.exportTarget(action.targetId);
        return;
      case "importData":
        await this.importData(action.targetId);
        return;
      case "clearTarget":
        await this.clearTarget(action.targetId);
        return;
      case "deleteTarget":
        await this.deleteTarget(action.targetId);
        return;
      case "moveTargetToGroup":
        await this.moveTargetToGroup(action.sourceTargetId, action.targetId, action.groupId);
        return;
      case "createWorkspaceLink":
        await this.createWorkspaceLink();
        return;
      case "linkWorkspaceToScope":
        await this.linkWorkspaceToExistingScope();
        return;
      case "unlinkWorkspaceScope":
        await this.unlinkWorkspaceScope();
        return;
      default:
        await this.refresh();
    }
  }

  private renderHtml(): string {
    const filterValue = this.state.readFilter();
    const filter = filterValue.toLowerCase();
    const viewMode = this.state.readViewMode();
    const workspaceStore = this.state.readStore("workspace");
    const profileStore = this.state.readStore("profile");
    const workspaceScope = this.state.getWorkspaceScope();
    const targets = this.state.listTargets();
    const selectedTargetId = this.state.readSelectedTarget();
    const selectedTarget = targets.find((target) => target.id === selectedTargetId) ?? targets[0];
    const shellState = this.state.readShellState();

    const workspaceHtml =
      viewMode === "workspace"
        ? this.renderWorkspaceBlocks(workspaceStore, filter)
        : this.renderSection("workspace", "Workspace", workspaceStore, filter);
    const profileHtml = viewMode === "workspace" ? "" : this.renderSection("profile", "Profile", profileStore, filter);
    const mainContent = `${workspaceHtml.replace("__WORKSPACE_SCOPE_META__", this.escapeHtml(workspaceScope ? `linked: ${workspaceScope.name}` : "local workspace"))}${profileHtml}`;
    const listsContent = this.renderTargetBrowser(targets, selectedTarget?.id ?? "workspace");
    const viewListContent = selectedTarget ? this.renderSelectedTargetView(selectedTarget.id, selectedTarget.label, filter) : '<div class="empty">No list selected.</div>';
    const transferContent = this.renderTransferSection(selectedTarget);

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
:root {
  color-scheme: light dark;
}
body {
  margin: 0;
  padding: 8px;
  color: var(--vscode-foreground);
  font-family: var(--vscode-font-family);
  font-size: 14px;
}
.toolbar {
  display: flex;
  gap: 6px;
  align-items: center;
  margin-bottom: 10px;
}
.input {
  flex: 1 1 auto;
  width: auto;
  min-width: 40px;
  border: 1px solid var(--vscode-input-border);
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  padding: 7px 10px;
  font-size: 14px;
  border-radius: 6px;
  outline: none;
}
.input:focus {
  border-color: var(--vscode-focusBorder);
}
.btn {
  border: 1px solid transparent;
  background: transparent;
  color: var(--vscode-foreground);
  border-radius: 6px;
  padding: 5px 7px;
  cursor: pointer;
}
.btn svg,
.icon-btn svg,
.section-btn svg,
.section-folder svg,
.item-icon svg,
.item-action svg,
.section-caret svg {
  width: 16px;
  height: 16px;
  display: block;
  stroke: currentColor;
  fill: none;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.section-btn svg,
.item-action svg {
  width: 18px;
  height: 18px;
}
.btn:hover,
.section-btn:hover,
.icon-btn:hover {
  background: color-mix(in srgb, var(--vscode-foreground) 12%, transparent);
}
.menu-wrap {
  margin-left: auto;
  position: relative;
}
.menu {
  position: absolute;
  right: 0;
  top: calc(100% + 6px);
  min-width: 250px;
  border: 1px solid color-mix(in srgb, var(--vscode-foreground) 22%, transparent);
  background: color-mix(in srgb, var(--vscode-sideBar-background) 88%, black 12%);
  border-radius: 8px;
  padding: 6px 0;
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.42);
  z-index: 30;
  display: none;
}
.menu.open {
  display: block;
}
.menu button {
  width: 100%;
  border: 0;
  background: transparent;
  color: var(--vscode-foreground);
  border-radius: 0;
  padding: 9px 12px;
  cursor: pointer;
  font-size: 14px;
  display: flex;
  align-items: center;
  gap: 8px;
  justify-content: space-between;
}
.menu button:hover {
  background: color-mix(in srgb, var(--vscode-list-hoverBackground) 80%, transparent);
}
.menu button.is-active {
  font-weight: 700;
}
.menu-check {
  width: 16px;
  display: inline-flex;
  justify-content: center;
  color: var(--vscode-terminal-ansiGreen);
  flex: 0 0 16px;
}
.menu-check svg {
  width: 16px;
  height: 16px;
  stroke: currentColor;
  fill: none;
  stroke-width: 2.2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.menu-label {
  flex: 1;
  text-align: left;
}
.menu-separator {
  height: 1px;
  margin: 4px 0;
  background: color-mix(in srgb, var(--vscode-foreground) 20%, transparent);
}
.shell {
  display: grid;
  gap: 0;
}
.shell-block {
  border-top: 1px solid color-mix(in srgb, var(--vscode-foreground) 14%, transparent);
}
.shell-block:last-child {
  border-bottom: 1px solid color-mix(in srgb, var(--vscode-foreground) 14%, transparent);
}
.shell-header {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 10px;
  background: transparent;
  border: 0;
  color: var(--vscode-foreground);
  cursor: pointer;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.shell-header:hover {
  background: color-mix(in srgb, var(--vscode-list-hoverBackground) 72%, transparent);
}
.shell-caret {
  display: inline-flex;
  transition: transform 120ms ease;
  transform: rotate(90deg);
}
.shell-caret.is-collapsed {
  transform: rotate(0deg);
}
.shell-body {
  padding: 8px;
}
.shell-block.is-collapsed .shell-body {
  display: none;
}
.target-list {
  display: grid;
  gap: 6px;
}
.target-item {
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid color-mix(in srgb, var(--vscode-foreground) 14%, transparent);
  background: color-mix(in srgb, var(--vscode-editor-background) 96%, black 4%);
  color: var(--vscode-foreground);
  border-radius: 8px;
  padding: 8px 10px;
  position: relative;
}
.target-item-main {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
  border: 0;
  background: transparent;
  color: inherit;
  padding: 0;
  cursor: pointer;
}
.target-item.is-active {
  border-color: color-mix(in srgb, var(--vscode-terminal-ansiGreen) 55%, transparent);
  background: color-mix(in srgb, var(--vscode-terminal-ansiGreen) 14%, transparent);
}
.target-item:hover,
.target-item-main:hover {
  background: color-mix(in srgb, var(--vscode-list-hoverBackground) 70%, transparent);
}
.target-item-title {
  font-size: 14px;
}
.target-item-meta {
  margin-left: auto;
  opacity: 0.72;
  font-size: 12px;
}
.target-item-actions {
  display: inline-flex;
  gap: 4px;
  margin-left: 8px;
  opacity: 0;
  pointer-events: none;
}
.target-item:hover .target-item-actions {
  opacity: 1;
  pointer-events: auto;
}
.drop-highlight {
  outline: 1px solid color-mix(in srgb, var(--vscode-terminal-ansiGreen) 70%, transparent);
  outline-offset: 2px;
  background: color-mix(in srgb, var(--vscode-terminal-ansiGreen) 12%, transparent);
}
.workspace-grid {
  display: grid;
  gap: 10px;
}
.workspace-card {
  border: 1px solid color-mix(in srgb, var(--vscode-foreground) 18%, transparent);
  border-radius: 10px;
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--vscode-sideBar-background) 86%, black 14%), transparent 70%),
    color-mix(in srgb, var(--vscode-editor-background) 94%, black 6%);
  overflow: hidden;
}
.workspace-card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid color-mix(in srgb, var(--vscode-foreground) 12%, transparent);
  cursor: pointer;
}
.workspace-card-title {
  font-size: 15px;
  font-weight: 600;
}
.workspace-card-body {
  padding: 10px 12px;
}
.workspace-card.is-collapsed .workspace-card-body {
  display: none;
}
.workspace-card-caret {
  display: inline-flex;
  transition: transform 120ms ease;
  transform: rotate(90deg);
}
.workspace-card.is-collapsed .workspace-card-caret {
  transform: rotate(0deg);
}
.section {
  border: 1px solid color-mix(in srgb, var(--vscode-foreground) 18%, transparent);
  border-radius: 8px;
  margin-bottom: 10px;
  overflow: hidden;
}
.section-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  background: color-mix(in srgb, var(--vscode-sideBar-background) 90%, black 10%);
  border-bottom: 1px solid color-mix(in srgb, var(--vscode-foreground) 12%, transparent);
  cursor: pointer;
}
.section-folder {
  color: var(--vscode-symbolIcon-folderForeground);
  display: inline-flex;
}
.section-caret {
  display: inline-flex;
  transition: transform 120ms ease;
  transform: rotate(90deg);
}
.section-caret.is-collapsed {
  transform: rotate(0deg);
}
.section-title {
  font-size: 15px;
  font-weight: 600;
}
.section-meta {
  margin-left: 6px;
  font-size: 12px;
  opacity: 0.8;
}
.section-actions {
  margin-left: auto;
  display: inline-flex;
  gap: 4px;
}
.section-btn,
.icon-btn {
  border: 1px solid transparent;
  background: transparent;
  color: var(--vscode-foreground);
  border-radius: 6px;
  padding: 3px 5px;
  cursor: pointer;
}
.section-body {
  padding: 8px;
}
.section.is-collapsed .section-body {
  display: none;
}
.group {
  border-left: 1px solid color-mix(in srgb, var(--vscode-foreground) 20%, transparent);
  margin-left: 4px;
  padding-left: 8px;
}
.group summary {
  list-style: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 0;
}
.group summary::-webkit-details-marker {
  display: none;
}
.group-name {
  font-size: 15px;
  font-weight: 600;
}
.group-folder {
  display: inline-flex;
  color: var(--vscode-symbolIcon-folderForeground);
}
.item-label {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
}
.item-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.item-actions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: 8px;
  opacity: 0;
  pointer-events: none;
}
.caret {
  display: inline-flex;
  transition: transform 120ms ease;
}
.group[open] .caret {
  transform: rotate(90deg);
}
.item-action {
  border: 1px solid transparent;
  background: transparent;
  color: color-mix(in srgb, var(--vscode-terminal-ansiGreen) 92%, white 8%);
  border-radius: 5px;
  padding: 2px;
  cursor: pointer;
}
.item-action[data-action="deleteGroup"],
.item-action[data-action="deleteTodo"] {
  color: color-mix(in srgb, var(--vscode-errorForeground) 92%, white 8%);
}
.item-action:hover {
  background: color-mix(in srgb, var(--vscode-terminal-ansiGreen) 20%, transparent);
  color: var(--vscode-terminal-ansiGreen);
}
.item-action[data-action="deleteGroup"]:hover,
.item-action[data-action="deleteTodo"]:hover {
  background: color-mix(in srgb, var(--vscode-errorForeground) 18%, transparent);
  color: var(--vscode-errorForeground);
}
.workspace-card-header:hover .item-actions,
.group summary:hover .item-actions,
.todo-row:hover .item-actions {
  opacity: 1;
  pointer-events: auto;
}
.todo-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0 3px 2px;
  font-size: 15px;
}
.todo-text {
  font-weight: 400;
}
.todo-main {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
}
.todo-check {
  width: 16px;
  height: 16px;
  border: 1.5px solid var(--vscode-foreground);
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
  position: relative;
  flex: 0 0 auto;
}
.todo-check.done {
  background: var(--vscode-button-background);
  border-color: var(--vscode-button-background);
}
.todo-check.done::after {
  content: "";
  position: absolute;
  left: 3px;
  top: 1px;
  width: 5px;
  height: 9px;
  border: solid var(--vscode-button-foreground);
  border-width: 0 2px 2px 0;
  transform: rotate(45deg);
}
.todo-text.done {
  text-decoration: line-through;
  opacity: 0.65;
}
.empty {
  opacity: 0.8;
  padding: 6px 2px;
}
</style>
</head>
<body>
  <div class="toolbar">
    <input id="filterInput" class="input" placeholder="Filter todos..." value="${this.escapeHtml(filterValue)}" />
    <div class="menu-wrap">
      <button id="menuToggle" class="btn" title="More actions">
        <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3" cy="8" r="1.1" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none"/><circle cx="13" cy="8" r="1.1" fill="currentColor" stroke="none"/></svg>
      </button>
      <div id="menu" class="menu">
        <button data-action="clearFilter"><span class="menu-label">Clear filter</span><span class="menu-check"></span></button>
        <div class="menu-separator"></div>
        <button class="${viewMode === "all" ? "is-active" : ""}" data-action="setViewMode" data-view-mode="all"><span class="menu-label">Show all sections</span><span class="menu-check">${viewMode === "all" ? '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 2.6 2.6 6.4-6.6"/></svg>' : ""}</span></button>
        <button class="${viewMode === "workspace" ? "is-active" : ""}" data-action="setViewMode" data-view-mode="workspace"><span class="menu-label">Show workspace only</span><span class="menu-check">${viewMode === "workspace" ? '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 2.6 2.6 6.4-6.6"/></svg>' : ""}</span></button>
        <div class="menu-separator"></div>
        <button data-action="createWorkspaceLink"><span class="menu-label">Create shared workspace project</span><span class="menu-check"></span></button>
        <button data-action="linkWorkspaceToScope"><span class="menu-label">Link workspace to existing project</span><span class="menu-check"></span></button>
        <button data-action="unlinkWorkspaceScope"><span class="menu-label">Unlink workspace project</span><span class="menu-check"></span></button>
        <div class="menu-separator"></div>
        <button data-action="setExpandAll"><span class="menu-label">Expand all groups</span><span class="menu-check"></span></button>
        <button data-action="setCollapseAll"><span class="menu-label">Collapse all groups</span><span class="menu-check"></span></button>
        <div class="menu-separator"></div>
        <button data-action="refresh"><span class="menu-label">Refresh</span><span class="menu-check"></span></button>
      </div>
    </div>
  </div>
  <div class="shell">
    <section class="shell-block ${shellState.main ? "" : "is-collapsed"}">
      <button type="button" class="shell-header" data-action="toggleShellSection" data-shell-id="main"><span class="shell-caret ${shellState.main ? "" : "is-collapsed"}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4.5 10 8l-4 3.5"/></svg></span><span>TODO EXTENSION</span></button>
      <div class="shell-body">${mainContent}</div>
    </section>
    <section class="shell-block ${shellState.lists ? "" : "is-collapsed"}">
      <button type="button" class="shell-header" data-action="toggleShellSection" data-shell-id="lists"><span class="shell-caret ${shellState.lists ? "" : "is-collapsed"}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4.5 10 8l-4 3.5"/></svg></span><span>LISTS</span></button>
      <div class="shell-body">${listsContent}</div>
    </section>
    <section class="shell-block ${shellState.viewList ? "" : "is-collapsed"}">
      <button type="button" class="shell-header" data-action="toggleShellSection" data-shell-id="viewList"><span class="shell-caret ${shellState.viewList ? "" : "is-collapsed"}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4.5 10 8l-4 3.5"/></svg></span><span>VIEW LIST</span></button>
      <div class="shell-body">${viewListContent}</div>
    </section>
    <section class="shell-block ${shellState.transfer ? "" : "is-collapsed"}">
      <button type="button" class="shell-header" data-action="toggleShellSection" data-shell-id="transfer"><span class="shell-caret ${shellState.transfer ? "" : "is-collapsed"}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4.5 10 8l-4 3.5"/></svg></span><span>TRANSFER</span></button>
      <div class="shell-body">${transferContent}</div>
    </section>
  </div>
<script>
const vscode = acquireVsCodeApi();
const menuToggle = document.getElementById('menuToggle');
const menu = document.getElementById('menu');
const filterInput = document.getElementById('filterInput');
const prevState = vscode.getState() || {};
let filterTimer;
let draggedTargetId = null;

if (prevState.filterValue && filterInput.value !== prevState.filterValue) {
  filterInput.value = prevState.filterValue;
}
if (prevState.keepFilterFocus) {
  requestAnimationFrame(() => {
    filterInput.focus();
    const pos = Number.isInteger(prevState.cursorPos) ? prevState.cursorPos : filterInput.value.length;
    filterInput.setSelectionRange(pos, pos);
  });
}

menuToggle.addEventListener('click', (event) => {
  event.stopPropagation();
  menu.classList.toggle('open');
});

document.addEventListener('click', () => {
  menu.classList.remove('open');
});

menu.addEventListener('click', (event) => {
  event.stopPropagation();
});

const postAction = (target) => {
  const action = target.getAttribute('data-action');
  if (!action) {
    return;
  }

  if (action === 'clearFilter') {
    filterInput.value = '';
    vscode.setState({ filterValue: '', keepFilterFocus: false, cursorPos: 0 });
  }

  const message = { type: action };
  if (target.dataset.mode) {
    message.mode = target.dataset.mode;
  }
  if (target.dataset.groupId) {
    message.groupId = target.dataset.groupId;
  }
  if (target.dataset.todoId) {
    message.todoId = target.dataset.todoId;
  }
  if (target.dataset.expand) {
    message.expand = target.dataset.expand === 'true';
  }
  if (target.dataset.viewMode) {
    message.viewMode = target.dataset.viewMode;
  }
  if (target.dataset.targetId) {
    message.targetId = target.dataset.targetId;
  }
  if (target.dataset.shellId) {
    message.shellId = target.dataset.shellId;
  }

  vscode.postMessage(message);
};

filterInput.addEventListener('input', () => {
  const pos = filterInput.selectionStart ?? filterInput.value.length;
  vscode.setState({ filterValue: filterInput.value, keepFilterFocus: true, cursorPos: pos });
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => {
    vscode.postMessage({ type: 'setFilter', value: filterInput.value || '' });
  }, 140);
});

filterInput.addEventListener('focus', () => {
  const pos = filterInput.selectionStart ?? filterInput.value.length;
  vscode.setState({ filterValue: filterInput.value, keepFilterFocus: true, cursorPos: pos });
});

filterInput.addEventListener('blur', () => {
  vscode.setState({ filterValue: filterInput.value, keepFilterFocus: false, cursorPos: filterInput.value.length });
});

document.querySelectorAll('[data-action]').forEach((element) => {
  element.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    postAction(event.currentTarget);
    menu.classList.remove('open');
  });
});

document.querySelectorAll('[data-drag-target-id]').forEach((element) => {
  element.addEventListener('dragstart', (event) => {
    draggedTargetId = element.dataset.dragTargetId;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', draggedTargetId || '');
  });
  element.addEventListener('dragend', () => {
    draggedTargetId = null;
    document.querySelectorAll('.drop-highlight').forEach((item) => item.classList.remove('drop-highlight'));
  });
});

document.querySelectorAll('[data-drop-target-id][data-drop-group-id]').forEach((element) => {
  element.addEventListener('dragover', (event) => {
    if (!draggedTargetId) {
      return;
    }
    if (draggedTargetId === element.dataset.dropTargetId) {
      return;
    }
    event.preventDefault();
    element.classList.add('drop-highlight');
  });
  element.addEventListener('dragleave', () => {
    element.classList.remove('drop-highlight');
  });
  element.addEventListener('drop', (event) => {
    if (!draggedTargetId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    element.classList.remove('drop-highlight');
    vscode.postMessage({
      type: 'moveTargetToGroup',
      sourceTargetId: draggedTargetId,
      targetId: element.dataset.dropTargetId,
      groupId: element.dataset.dropGroupId
    });
    draggedTargetId = null;
  });
});
</script>
</body>
</html>`;
  }

  private renderTargetBrowser(targets: ListTarget[], selectedTargetId: StoreTargetId): string {
    return `<div class="target-list">
      ${targets
        .map(
          (target) => `<div class="target-item ${target.id === selectedTargetId ? "is-active" : ""}" data-drag-target-id="${target.id}" draggable="true">
            <button type="button" class="target-item-main" data-action="selectTarget" data-target-id="${target.id}">
              <span class="section-folder"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 6h4.4l1.4-2H14v8.5H2z"/><path d="M2 6h12"/></svg></span>
              <span class="target-item-title">${this.escapeHtml(target.label)}</span>
              <span class="target-item-meta">${this.escapeHtml(target.description)}</span>
            </button>
            <span class="target-item-actions">
              ${target.id.startsWith("scope:") ? `<button type="button" class="item-action" data-action="deleteTarget" data-target-id="${target.id}" title="Delete list"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 4.5h9"/><path d="M6 4.5V3h4v1.5"/><path d="M5 6v6.5h6V6"/><path d="M7.5 7.5v3.5M10.5 7.5v3.5"/></svg></button>` : `<button type="button" class="item-action" data-action="clearTarget" data-target-id="${target.id}" title="Clear list"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.5h11"/><path d="M5.5 4.5V3h5v1.5"/><path d="M4.5 6.5v5.5"/><path d="M8 6.5v5.5"/><path d="M11.5 6.5v5.5"/></svg></button>`}
            </span>
          </div>`
        )
        .join("")}
    </div>`;
  }

  private renderSelectedTargetView(targetId: StoreTargetId, label: string, filter: string): string {
    const store = this.state.readTargetStore(targetId);
    const meta = targetId.startsWith("scope:") ? "shared project" : targetId;
    return this.renderSection(targetId, label, store, filter, meta, false);
  }

  private renderSection(targetId: StoreTargetId, title: string, store: TodoStore, filter: string, metaOverride?: string, showTransferActions = false): string {
    const groupsHtml = store.groups
      .map((g) => this.renderGroup(targetId, g, 0, filter, store.hideCompleted, store.expandGroups))
      .filter(Boolean)
      .join("");

    return `<section class="section ${store.sectionCollapsed ? "is-collapsed" : ""}">
      <div class="section-header" data-action="toggleSectionCollapsed" data-target-id="${targetId}">
        <span class="section-caret ${store.sectionCollapsed ? "is-collapsed" : ""}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4.5 10 8l-4 3.5"/></svg></span>
        <span class="section-folder"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 6h4.4l1.4-2H14v8.5H2z"/><path d="M2 6h12"/></svg></span>
        <span class="section-title">${title}</span>
        <span class="section-meta">${targetId === "workspace" ? "__WORKSPACE_SCOPE_META__ | " : metaOverride ? `${metaOverride} | ` : ""}${store.hideCompleted ? "hide done" : "show done"} | ${store.expandGroups ? "expanded" : "collapsed"}</span>
        <span class="section-actions">
          <button type="button" class="section-btn" data-action="addRootGroup" data-target-id="${targetId}" title="Add root group"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 5.5h5l1.2 1.5H14v6.5H2z"/><path d="M12.5 2.5v3M11 4h3"/></svg></button>
          <button type="button" class="section-btn" data-action="addTodo" data-target-id="${targetId}" title="Add TODO"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3.5h7.5v9H3z"/><path d="M5 6h3.5M5 8h3.5"/><path d="M12.5 8v4M10.5 10h4"/></svg></button>
          ${showTransferActions ? `<button type="button" class="section-btn" data-action="clearTarget" data-target-id="${targetId}" title="Clear list"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.5h11"/><path d="M5.5 4.5V3h5v1.5"/><path d="M4.5 6.5v5.5"/><path d="M8 6.5v5.5"/><path d="M11.5 6.5v5.5"/></svg></button>` : ""}
          <button type="button" class="section-btn" data-action="setSectionExpand" data-target-id="${targetId}" data-expand="${store.expandGroups ? "false" : "true"}" title="${store.expandGroups ? "Collapse groups" : "Expand groups"}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6.5 8 10l4-3.5"/></svg></button>
          <button type="button" class="section-btn" data-action="toggleHideCompleted" data-target-id="${targetId}" title="Toggle hide completed"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 8s2-3.5 5.5-3.5S13.5 8 13.5 8s-2 3.5-5.5 3.5S2.5 8 2.5 8z"/><circle cx="8" cy="8" r="1.7"/></svg></button>
        </span>
      </div>
      <div class="section-body">
        ${groupsHtml || '<div class="empty">No groups yet.</div>'}
      </div>
    </section>`;
  }

  private renderWorkspaceBlocks(store: TodoStore, filter: string): string {
    const cardsHtml = store.groups
      .map((group) => this.renderWorkspaceCard("workspace", group, filter, store.hideCompleted, store.expandGroups, store.collapsedGroupIds))
      .filter(Boolean)
      .join("");

    return `<section class="section ${store.sectionCollapsed ? "is-collapsed" : ""}">
      <div class="section-header" data-action="toggleSectionCollapsed" data-mode="workspace">
        <span class="section-caret ${store.sectionCollapsed ? "is-collapsed" : ""}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4.5 10 8l-4 3.5"/></svg></span>
        <span class="section-folder"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 6h4.4l1.4-2H14v8.5H2z"/><path d="M2 6h12"/></svg></span>
        <span class="section-title">Workspace</span>
        <span class="section-meta">__WORKSPACE_SCOPE_META__ | block view</span>
        <span class="section-actions">
          <button type="button" class="section-btn" data-action="addRootGroup" data-mode="workspace" title="Add root group"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 5.5h5l1.2 1.5H14v6.5H2z"/><path d="M12.5 2.5v3M11 4h3"/></svg></button>
        </span>
      </div>
      <div class="section-body">
        <div class="workspace-grid">
          ${cardsHtml || '<div class="empty">No workspace groups yet.</div>'}
        </div>
      </div>
    </section>`;
  }

  private renderWorkspaceCard(
    targetId: StoreTargetId,
    group: TodoGroup,
    filter: string,
    hideCompleted: boolean,
    expandGroups: boolean,
    collapsedGroupIds: string[]
  ): string {
    const visibleSubgroups = group.groups
      .map((child) => this.renderGroup(targetId, child, 0, filter, hideCompleted, expandGroups))
      .filter(Boolean)
      .join("");
    const visibleTodos = group.todos
      .filter((todo) => this.todoMatches(todo, filter, hideCompleted))
      .map((todo) => this.renderTodo(targetId, todo, 0))
      .join("");
    const groupMatch = !filter || group.name.toLowerCase().includes(filter);
    const hasVisibleChildren = Boolean(visibleSubgroups || visibleTodos);

    if (!groupMatch && !hasVisibleChildren) {
      return "";
    }

    const isCollapsed = collapsedGroupIds.includes(group.id);

    return `<article class="workspace-card ${isCollapsed ? "is-collapsed" : ""}">
      <div class="workspace-card-header" data-action="toggleGroupCardCollapsed" data-target-id="${targetId}" data-group-id="${group.id}" data-drop-target-id="${targetId}" data-drop-group-id="${group.id}">
        <span class="workspace-card-caret"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4.5 10 8l-4 3.5"/></svg></span>
        <span class="section-folder"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 6h4.4l1.4-2H14v8.5H2z"/><path d="M2 6h12"/></svg></span>
        <span class="workspace-card-title">${this.escapeHtml(group.name)}</span>
        <span class="item-actions">
          <button type="button" class="item-action" data-action="addSubgroup" data-target-id="${targetId}" data-group-id="${group.id}" title="Add subgroup"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 5.5h5l1.2 1.5H14v6.5H2z"/><path d="M12.5 3v3M11 4.5h3"/></svg></button>
          <button type="button" class="item-action" data-action="addTodo" data-target-id="${targetId}" data-group-id="${group.id}" title="Add TODO"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3.5h7.5v9H3z"/><path d="M5 6h3.5M5 8h3.5"/><path d="M12.5 8v4M10.5 10h4"/></svg></button>
          <button type="button" class="item-action" data-action="deleteGroup" data-target-id="${targetId}" data-group-id="${group.id}" title="Delete group"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 4.5h9"/><path d="M6 4.5V3h4v1.5"/><path d="M5 6v6.5h6V6"/><path d="M7.5 7.5v3.5M10.5 7.5v3.5"/></svg></button>
        </span>
      </div>
      <div class="workspace-card-body">
        ${visibleTodos || visibleSubgroups ? `${visibleTodos}${visibleSubgroups}` : '<div class="empty">No TODOs yet.</div>'}
      </div>
    </article>`;
  }

  private renderGroup(
    targetId: StoreTargetId,
    group: TodoGroup,
    depth: number,
    filter: string,
    hideCompleted: boolean,
    expandGroups: boolean
  ): string {
    const visibleSubgroups = group.groups
      .map((g) => this.renderGroup(targetId, g, depth + 1, filter, hideCompleted, expandGroups))
      .filter(Boolean)
      .join("");

    const visibleTodos = group.todos
      .filter((t) => this.todoMatches(t, filter, hideCompleted))
      .map((t) => this.renderTodo(targetId, t, depth))
      .join("");

    const groupMatch = !filter || group.name.toLowerCase().includes(filter);
    const hasVisibleChildren = Boolean(visibleSubgroups || visibleTodos);
    if (!groupMatch && !hasVisibleChildren) {
      return "";
    }

    return `<details class="group" ${expandGroups ? "open" : ""} style="margin-left:${depth * 12}px;">
      <summary data-drop-target-id="${targetId}" data-drop-group-id="${group.id}">
        <span class="caret"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4.5 10 8l-4 3.5"/></svg></span>
        <span class="item-label">
          <span class="group-folder item-icon"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 6h4.4l1.4-2H14v8.5H2z"/><path d="M2 6h12"/></svg></span>
          <span class="group-name item-text">${this.escapeHtml(group.name)}</span>
          <span class="item-actions">
            <button type="button" class="item-action" data-action="addSubgroup" data-target-id="${targetId}" data-group-id="${group.id}" title="Add subgroup"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 5.5h5l1.2 1.5H14v6.5H2z"/><path d="M12.5 3v3M11 4.5h3"/></svg></button>
            <button type="button" class="item-action" data-action="addTodo" data-target-id="${targetId}" data-group-id="${group.id}" title="Add TODO"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3.5h7.5v9H3z"/><path d="M5 6h3.5M5 8h3.5"/><path d="M12.5 8v4M10.5 10h4"/></svg></button>
            <button type="button" class="item-action" data-action="deleteGroup" data-target-id="${targetId}" data-group-id="${group.id}" title="Delete group"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 4.5h9"/><path d="M6 4.5V3h4v1.5"/><path d="M5 6v6.5h6V6"/><path d="M7.5 7.5v3.5M10.5 7.5v3.5"/></svg></button>
          </span>
        </span>
      </summary>
      ${visibleTodos}
      ${visibleSubgroups}
    </details>`;
  }

  private renderTodo(targetId: StoreTargetId, todo: TodoItem, depth: number): string {
    const doneClass = todo.done ? "done" : "";

    return `<div class="todo-row" style="margin-left:${(depth + 1) * 12}px;">
      <span class="todo-main">
        <button type="button" class="todo-check ${doneClass}" data-action="toggleDone" data-target-id="${targetId}" data-todo-id="${todo.id}" title="Mark TODO done/undone"></button>
        <span class="todo-text ${doneClass} item-text">${this.escapeHtml(todo.text)}</span>
        <span class="item-actions">
          <button type="button" class="item-action" data-action="deleteTodo" data-target-id="${targetId}" data-todo-id="${todo.id}" title="Delete TODO"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 4.5h9"/><path d="M6 4.5V3h4v1.5"/><path d="M5 6v6.5h6V6"/><path d="M7.5 7.5v3.5M10.5 7.5v3.5"/></svg></button>
        </span>
      </span>
    </div>`;
  }

  private renderTransferSection(selectedTarget?: ListTarget): string {
    return `<section class="section">
      <div class="section-header">
        <span class="section-folder"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 6h4.4l1.4-2H14v8.5H2z"/><path d="M2 6h12"/></svg></span>
        <span class="section-title">Transfer</span>
        <span class="section-meta">${this.escapeHtml(selectedTarget?.label ?? "no list selected")}</span>
      </div>
      <div class="section-body">
        <div class="target-list">
          <button type="button" class="target-item" data-action="exportAll">
            <span class="section-folder"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v7"/><path d="M5.5 7 8 9.5 10.5 7"/><path d="M3 11.5h10v2H3z"/></svg></span>
            <span class="target-item-title">Export all lists</span>
          </button>
          <button type="button" class="target-item" data-action="importData">
            <span class="section-folder"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 9.5v-7"/><path d="M5.5 5 8 2.5 10.5 5"/><path d="M3 11.5h10v2H3z"/></svg></span>
            <span class="target-item-title">Import lists</span>
          </button>
          ${
            selectedTarget
              ? `<button type="button" class="target-item" data-action="exportTarget" data-target-id="${selectedTarget.id}">
            <span class="section-folder"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v7"/><path d="M5.5 7 8 9.5 10.5 7"/><path d="M3 11.5h10v2H3z"/></svg></span>
            <span class="target-item-title">Export selected list</span>
            <span class="target-item-meta">${this.escapeHtml(selectedTarget.label)}</span>
          </button>
          <button type="button" class="target-item" data-action="importData" data-target-id="${selectedTarget.id}">
            <span class="section-folder"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 9.5v-7"/><path d="M5.5 5 8 2.5 10.5 5"/><path d="M3 11.5h10v2H3z"/></svg></span>
            <span class="target-item-title">Import into selected list</span>
            <span class="target-item-meta">${this.escapeHtml(selectedTarget.label)}</span>
          </button>`
              : ""
          }
        </div>
      </div>
    </section>`;
  }

  private todoMatches(todo: TodoItem, filter: string, hideCompleted: boolean): boolean {
    if (hideCompleted && todo.done) {
      return false;
    }
    if (!filter) {
      return true;
    }
    return todo.text.toLowerCase().includes(filter);
  }

  private flattenGroups(groups: TodoGroup[]): TodoGroup[] {
    return groups.flatMap((g) => [g, ...this.flattenGroups(g.groups)]);
  }

  private findGroupById(groups: TodoGroup[], id: string): TodoGroup | undefined {
    for (const group of groups) {
      if (group.id === id) {
        return group;
      }
      const inChild = this.findGroupById(group.groups, id);
      if (inChild) {
        return inChild;
      }
    }
    return undefined;
  }

  private findTodoRef(groups: TodoGroup[], todoId: string): { group: TodoGroup; todo: TodoItem } | undefined {
    for (const group of groups) {
      const todo = group.todos.find((t) => t.id === todoId);
      if (todo) {
        return { group, todo };
      }
      const inChild = this.findTodoRef(group.groups, todoId);
      if (inChild) {
        return inChild;
      }
    }
    return undefined;
  }

  private deleteTodoById(groups: TodoGroup[], todoId: string): boolean {
    for (const group of groups) {
      const index = group.todos.findIndex((t) => t.id === todoId);
      if (index >= 0) {
        group.todos.splice(index, 1);
        return true;
      }
      const removedInChild = this.deleteTodoById(group.groups, todoId);
      if (removedInChild) {
        return true;
      }
    }
    return false;
  }

  private deleteGroupById(groups: TodoGroup[], id: string): boolean {
    const atRoot = groups.findIndex((g) => g.id === id);
    if (atRoot >= 0) {
      groups.splice(atRoot, 1);
      return true;
    }

    for (const group of groups) {
      const removed = this.deleteGroupById(group.groups, id);
      if (removed) {
        return true;
      }
    }
    return false;
  }

  private async cleanupExpiredCompletedTodos(mode: StorageMode): Promise<void> {
    const store = this.state.readStore(mode);
    const before = JSON.stringify(store.groups);
    const dayMs = 24 * 60 * 60 * 1000;
    const now = Date.now();

    this.cleanupGroup(store.groups, now, dayMs);

    if (JSON.stringify(store.groups) !== before) {
      await this.state.writeStore(mode, store);
    }
  }

  private cleanupGroup(groups: TodoGroup[], now: number, ttlMs: number): void {
    for (const group of groups) {
      group.todos = group.todos.filter((todo) => {
        if (!todo.done || !todo.completedAt) {
          return true;
        }
        return now - todo.completedAt < ttlMs;
      });
      this.cleanupGroup(group.groups, now, ttlMs);
    }
  }

  private newId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  private normalizeStore(raw?: Partial<TodoStore>): TodoStore {
    const hideDefault = vscode.workspace
      .getConfiguration("todoListPro")
      .get<boolean>("hideCompletedByDefault", false);

    return {
      groups: raw?.groups ?? [],
      hideCompleted: raw?.hideCompleted ?? hideDefault,
      expandGroups: raw?.expandGroups ?? true,
      sectionCollapsed: raw?.sectionCollapsed ?? false,
      collapsedGroupIds: raw?.collapsedGroupIds ?? []
    };
  }

  private async writeExportFile(entries: ExportEntry[], defaultFileName: string): Promise<void> {
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file("."), defaultFileName),
      filters: { JSON: ["json"] },
      saveLabel: "Export TODO data"
    });
    if (!uri) {
      return;
    }

    const payload: ExportPayload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      entries
    };

    await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(payload, null, 2), "utf8"));
    void vscode.window.showInformationMessage(`Exported ${entries.length} list${entries.length === 1 ? "" : "s"}.`);
  }

  private slugify(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "list";
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const state = new TodoState(context);
  const controller = new TodoController(state);

  const pickMode = async (): Promise<StorageMode | undefined> => {
    const picked = await vscode.window.showQuickPick(
      [
        { label: "Workspace", mode: "workspace" as StorageMode },
        { label: "Profile", mode: "profile" as StorageMode }
      ],
      { title: "Select TODO section" }
    );
    return picked?.mode;
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("todoListProView", controller),
    vscode.commands.registerCommand("todoListPro.addGroup", async () => {
      const mode = await pickMode();
      if (mode) {
        await controller.addGroup(mode);
      }
    }),
    vscode.commands.registerCommand("todoListPro.addSubgroup", async () => {
      vscode.window.showInformationMessage("Use subgroup icon on a group row.");
    }),
    vscode.commands.registerCommand("todoListPro.addTodo", async () => {
      const mode = await pickMode();
      if (mode) {
        await controller.addTodo(mode);
      }
    }),
    vscode.commands.registerCommand("todoListPro.toggleDone", async () => {
      vscode.window.showInformationMessage("Use checkbox in TODO list.");
    }),
    vscode.commands.registerCommand("todoListPro.deleteItem", async () => {
      vscode.window.showInformationMessage("Use delete icon on item row.");
    }),
    vscode.commands.registerCommand("todoListPro.setFilter", async () => {
      const value = await vscode.window.showInputBox({ prompt: "Filter TODOs/groups" });
      if (typeof value === "string") {
        await controller.setFilter(value);
      }
    }),
    vscode.commands.registerCommand("todoListPro.clearFilter", async () => {
      await controller.clearFilter();
    }),
    vscode.commands.registerCommand("todoListPro.setExpandAll", async () => {
      await controller.setExpandAll(true);
    }),
    vscode.commands.registerCommand("todoListPro.setCollapseAll", async () => {
      await controller.setExpandAll(false);
    }),
    vscode.commands.registerCommand("todoListPro.toggleHideCompleted", async () => {
      const mode = await pickMode();
      if (mode) {
        await controller.toggleHideCompleted(mode);
      }
    }),
    vscode.commands.registerCommand("todoListPro.createWorkspaceLink", async () => {
      await controller.createWorkspaceLink();
    }),
    vscode.commands.registerCommand("todoListPro.linkWorkspaceToScope", async () => {
      await controller.linkWorkspaceToExistingScope();
    }),
    vscode.commands.registerCommand("todoListPro.unlinkWorkspaceScope", async () => {
      await controller.unlinkWorkspaceScope();
    }),
    vscode.commands.registerCommand("todoListPro.setStorageWorkspace", async () => {
      vscode.window.showInformationMessage("Storage switch is not needed now. Workspace and Profile sections are shown together.");
    }),
    vscode.commands.registerCommand("todoListPro.setStorageProfile", async () => {
      vscode.window.showInformationMessage("Storage switch is not needed now. Workspace and Profile sections are shown together.");
    }),
    vscode.commands.registerCommand("todoListPro.refresh", async () => {
      await controller.refresh();
    })
  );
}

export function deactivate(): void {
  // no-op
}
