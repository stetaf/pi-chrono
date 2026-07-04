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
- **Blob storage**: Content-addressed blob store for before/after file versions
- **Rollback preview**: Shows exactly which files will change before confirming
- **Status monitoring**: `/chrono status` for health & storage diagnostics
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

### Commands

Use the `/chrono` command with an optional subcommand:

```
/chrono            List and restore rollback points
/chrono status     Show chrono health & storage state
```

#### Rollback (`/chrono`)

Running `/chrono` without arguments will:

- Display all available rollback points (with timestamps and message previews)
- Let you select which point to restore
- Confirm before proceeding
- Restore the workspace and fork the session at that point

#### Status (`/chrono status`)

Running `/chrono status` shows an overview of the chrono system:

- Number of stored checkpoints and their validity
- Journal disk stats (total / readable / corrupt files)
- Blob storage size
- Pending pre-manifest status

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
~/.pi/chrono/
├── blobs/              # Content-addressed blob store (before/after file versions)
└── sessions/
    └── <sessionId>/
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
├── index.ts            # Extension entry point, event handlers, command registration
├── types.ts            # Data structures (Checkpoint, Journal, PreManifest, etc.)
├── commands.ts         # Chrono command parsing (subcommands: status)
├── journal.ts          # File operation tracking, reversal, and blob management
├── paths.ts            # Directory constants, session path resolution, ignore rules
├── state.ts            # Checkpoint and pending-pre persistence (load/save)
├── fs-utils.ts         # File system walking, hashing (SHA256), file copy
├── status.ts           # Status report generation (checkpoint validity, disk stats)
├── rollback-preview.ts # Rollback preview builder (operations, validation)
test/
└── smoke.ts           # Basic functionality tests
```

## API Reference

### Events listened to

- `session_start`: Initialize checkpoints and load state
- `session_shutdown`: Finalize pending checkpoints
- `before_agent_start`: Capture pre-manifest before AI turn
- `turn_end`: Finalize journal after AI turn completes
- `session_before_fork`: Handle rollback when forking session

### Commands registered

- `chrono`: List and restore rollback points (default)
- `chrono status`: Show chrono health & storage state

## License

MIT © stefa
