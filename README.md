# Projects TODO Advanced

Projects TODO Advanced is a structured TODO sidebar for VS Code with standalone lists, nested folders, quick task entry, drag and drop, and native view menu actions.

It is built for people who want project task management directly in the editor instead of another app or TODO comments scattered across files.

## What It Does

- Create standalone TODO lists and show only selected lists in the current workspace
- Organize tasks into nested folders
- Add tasks quickly with inline inputs at the bottom of lists and folders
- Drag tasks and folders between lists and folders
- Rename tasks, folders, and lists inline from hover actions
- Import and export all lists or a single list
- Clean up completed tasks automatically after a configurable retention period
- Use VS Code native view actions for visibility, retention, import/export, and list creation
- Keep local storage as the default, or share lists through a normal GitHub repository without deleting the local copy

## Screenshots

### Overview

![Overview](media/store/screenshot-overview.png)

### Drag And Drop

![Drag and drop](media/store/screenshot-drag-drop.png)

### Import / Export

![Import and export](media/store/screenshot-transfer.png)

## Main Workflows

### 1. Build lists for each project area

Create separate lists for backend, frontend, bugs, release prep, or imported planning notes.

### 2. Show only relevant lists in each workspace

Use the native `...` menu in the view title and open `Workspace Visibility...` to choose which lists are visible in the current workspace.

### 3. Add tasks fast

Hover a list or folder and use the inline quick-add input at the bottom of its content.

### 4. Reorganize by drag and drop

Move tasks or whole folders into another list or nested folder using the drag handle.

### 5. Keep done items for a limited time

Set `Completed Retention...` from the native menu to keep completed tasks for `1, 3, 8, 14, 30, or 90` days.

### 6. Keep local data or switch to Share Mode

Use `Storage Mode...` to choose one of these options:

- Keep local storage
- Switch to Share Mode
- Back to Local Mode

Share Mode uses a central GitHub repository named `TodoExtension` that the extension creates automatically through the signed-in VS Code GitHub account if it does not exist yet. Shared lists are stored as JSON files under `lists/`. The mode switch never deletes or overwrites local data.

## Native View Menu

The view title `...` menu includes:

- `Create List`
- `Workspace Visibility...`
- `Completed Retention...`
- `Export All`
- `Export Single List...`
- `Import`

## Import / Export Format

The extension uses JSON for import and export:

```json
{
  "version": 2,
  "exportedAt": "2026-04-02T12:00:00.000Z",
  "entries": [
    {
      "list": {
        "id": "list-example",
        "name": "Release",
        "createdAt": 1712059200000,
        "store": {
          "groups": [],
          "todos": []
        }
      }
    }
  ]
}
```

## Run In Development

1. `npm install`
2. `npm run compile`
3. Press `F5` in VS Code
4. Open the `TODO` activity bar icon in the Extension Development Host

## Packaging

```bash
vsce package
```
