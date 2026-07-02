# pi-chrono

**Session rollback for Pi Coding Agent** — rewind your conversation and restore file state.

## Overview

pi-chrono is an extension for [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent) that enables time-travel-style session management. It automatically captures file states before each AI turn and lets you roll back to any previous checkpoint, restoring both the workspace and the session context.

Perfect for when you want to undo AI-generated changes without losing your conversation history.

## Features

- **Automatic checkpoints**: Captures file states before every AI turn
- **Manual rollback**: Use the `/chrono` command to restore any previous state
- **Workspace restoration**: Restores files to their exact previous condition
- **Session forking**: Creates a new branch from any point in your conversation
- **Journal system**: Tracks file operations (create/modify/delete) with full reversal support
- **Garbage collection**: Automatically cleans up obsolete checkpoint data

## Installation

### Using npm

```bash
pi install npm:pi-chrono
```

### From GitHub

```bash
pi install github.com/stetaf/pi-chrono
```

## Usage

### Automatic behavior

pi-chrono works automatically once installed:

1. **Before each AI turn**: Captures current file state (metadata + content hashes)
2. **After each turn**: Creates a journal entry tracking all file operations
3. **On session start**: Loads existing checkpoints and garbage-collects old data

No configuration required — it just works.

### Manual rollback

Use the `chrono` command to list and restore checkpoints:

```
/chrono
```

This will:

1. Display all available rollback points (with timestamps and message previews)
2. Let you select which point to restore
3. Confirm before proceeding
4. Restore the workspace and fork the session at that point

### What happens during rollback?

When you roll back to a checkpoint:

- ✅ All files are restored to their state before that turn
- ✅ The session is forked at the selected entry
- ✅ You can continue working from that point forward
- ⚠️ The action cannot be undone — create new checkpoints after rollback if needed

## How it works

pi-chrono uses three core mechanisms:

1. **Pre-manifests**: Captured before each AI turn, containing file metadata (path, mtime, size, SHA256)

2. **Journals**: Created after each turn, recording all filesystem operations:
    - `modified`: File changed (with before/after blob tracking)
    - `created`: New file added
    - `deleted`: File removed

3. **Checkpoints**: Persistent records linking journals to conversation entries for easy restoration

### Storage structure

```
~/.pi/sessions/<sessionId>/
├── state.json          # Checkpoint metadata
├── pending-pre.json    # Current turn's pre-manifest
└── journals/
    ├── <entryId>.json  # Journal entries for each turn
```

## Development

### Prerequisites

- Node.js 20+ (with experimental strip-types support)
- TypeScript 5.9+

### Scripts

```bash
# Type-check without emitting files
npm run typecheck

# Run smoke tests
npm test
```

### Project structure

```
src/
├── index.ts      # Extension entry point and command registration
├── types.ts      # Data structures (Checkpoint, Journal, PreManifest)
├── journal.ts    # File operation tracking and reversal logic
├── paths.ts      # Session directory management
└── state.ts      # Checkpoint persistence (load/save)
test/
└── smoke.ts     # Basic functionality tests
```

## API Reference

### Events listened to

- `session_start`: Initialize checkpoints and load state
- `session_shutdown`: Finalize pending checkpoints
- `before_agent_start`: Capture pre-manifest before AI turn
- `turn_end`: Finalize journal after AI turn completes
- `session_before_fork`: Handle rollback when forking session

### Commands registered

- `chrono`: List and select rollback points

## License

MIT © stefa
