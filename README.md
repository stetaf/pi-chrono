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
- **Rollback diff inspection**: `/chrono diff` to inspect rollback impact without restoring
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
/chrono diff       Inspect file changes before rollback
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

#### Diff (`/chrono diff`)

Running `/chrono diff` lets you inspect a rollback target without forking the session or restoring files:

- Select a rollback checkpoint using the same picker as `/chrono`
- See affected file counts grouped by operation kind
- See modified, recreated, and removed paths
- Use `/chrono diff --full` to show all affected paths
- Use `/chrono diff --content` to include compact text-level diffs for modified files

### What happens during rollback?

When you roll back to a checkpoint:

- ✅ All files are restored to their state before that turn
- ✅ The session is forked at the selected entry
- ✅ You can continue working from that point forward
- ⚠️ The action cannot be undone — create new checkpoints after rollback if needed

## Configuration

### Ignore system

pi-chrono skips common non-essential directories and files when scanning the workspace. The ignore list covers multiple ecosystems:

| Category          | Ignored paths                                                                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **JS / Node**     | `node_modules`, `.next`, `.nuxt`, `dist`, `build`, `.turbo`, `.parcel-cache`                                                                                                               |
| **Python**        | `__pycache__`, `.venv`, `venv`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`, `.tox`                                                                                                      |
| **PHP / Laravel** | `vendor`, `bootstrap/cache`, `storage/framework/cache/**`, `storage/framework/views/**`, `storage/logs/**`, `storage/framework/sessions/**`, `storage/framework/testing/**`                |
| **Build / cache** | `target`, `out`, `.cache`, `coverage`, `.nyc_output`, `tmp`, `temp`, `.dart_tool`, `.gradle`, `.m2`, `Pods`, `.pub-cache`, `.svelte-kit`, `.astro`, `.output`, `.eggs`, `**/*.egg-info/**` |
| **VCS**           | `.git`, `.svn`, `.hg`                                                                                                                                                                      |
| **IDE / Editor**  | `.idea`, `.vscode`, `**/*.swp`                                                                                                                                                             |
| **OS / Logs**     | `.DS_Store`, `Thumbs.db`, `*.log`, `*.tmp`, `*.temp`, `*.bak`, files ending with `~`                                                                                                       |

### `.chronoignore`

You can extend or override the default ignore rules by placing a `.chronoignore` file in your project root. The syntax is a gitignore-style subset:

```gitignore
*.log               # Ignore all .log files (anywhere)
.env                # Ignore files/directories named .env
custom/             # Ignore the custom/ directory entirely
node_modules/local  # Ignore a specific nested path
```

Supported syntax:

- **Empty lines** and **`#` comments** are ignored
- **Trailing `/`** — directory-only ignore
- **`path/with/slashes`** — matches relative to any ancestor
- **`*.ext`** — suffix-based ignore anywhere in the tree
- **Plain names** — directory or file name match

Rules from `.chronoignore` are merged **after** the default preset, so they can extend but not negate built-in rules.

### Environment variables

| Variable                     | Default              | Description                                                          |
| ---------------------------- | -------------------- | -------------------------------------------------------------------- |
| `PI_CHRONO_HASH_CONCURRENCY` | `8`                  | Max concurrent file hashing operations                               |
| `PI_CHRONO_MAX_FILE_SIZE`    | `104857600` (100 MB) | Files larger than this are skipped                                   |
| `PI_CHRONO_STRICT_HASH`      | `false`              | When `true`, always compute full SHA256 even if `mtime`+`size` match |

### Hashing tradeoff (`mtime` + `size` vs full SHA256)

By default, pi-chrono uses an **optimistic caching** strategy:

- When a file's `mtime` (modification time) and `size` are unchanged between turns, the file is considered **unchanged** and its previous SHA256 hash is reused.
- Only files where `mtime` or `size` differ are re-hashed to detect content changes.

**Why**: In normal AI turns, the vast majority of files are not touched — re-hashing every file after every turn would be wasteful.

**Edge case**: On some filesystems, `mtime` resolution is limited (e.g., FAT32: 2 seconds, HFS+: 1 second). A file could be modified twice within the same clock tick, producing identical `mtime` + `size` but different content.

- **Default (fast)**: Trust `mtime` + `size` — sufficient for virtually all real-world workflows on NTFS, APFS, ext4, etc.
- **Strict mode**: Set `PI_CHRONO_STRICT_HASH=1` to always compute the full SHA256, eliminating the edge case at the cost of performance.

## Configuration

### Ignore system

pi-chrono skips common non-essential directories and files when scanning the workspace. The ignore list covers multiple ecosystems:

| Category          | Ignored paths                                                                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **JS / Node**     | `node_modules`, `.next`, `.nuxt`, `dist`, `build`, `.turbo`, `.parcel-cache`                                                                                                               |
| **Python**        | `__pycache__`, `.venv`, `venv`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`, `.tox`                                                                                                      |
| **PHP / Laravel** | `vendor`, `bootstrap/cache`, `storage/framework/cache/**`, `storage/framework/views/**`, `storage/logs/**`, `storage/framework/sessions/**`, `storage/framework/testing/**`                |
| **Build / cache** | `target`, `out`, `.cache`, `coverage`, `.nyc_output`, `tmp`, `temp`, `.dart_tool`, `.gradle`, `.m2`, `Pods`, `.pub-cache`, `.svelte-kit`, `.astro`, `.output`, `.eggs`, `**/*.egg-info/**` |
| **VCS**           | `.git`, `.svn`, `.hg`                                                                                                                                                                      |
| **IDE / Editor**  | `.idea`, `.vscode`, `**/*.swp`                                                                                                                                                             |
| **OS / Logs**     | `.DS_Store`, `Thumbs.db`, `*.log`, `*.tmp`, `*.temp`, `*.bak`, files ending with `~`                                                                                                       |

### `.chronoignore`

You can extend or override the default ignore rules by placing a `.chronoignore` file in your project root. The syntax is a gitignore-style subset:

```gitignore
# Comments start with hash
*.log          # Ignore all .log files (anywhere)
.env           # Ignore files/directories named .env
custom/        # Ignore the custom/ directory entirely
node_modules/local  # Ignore a specific nested path
```

Supported syntax:

- **Empty lines** and **`#` comments** are ignored
- **Trailing `/`** — directory-only ignore
- **`path/with/slashes`** — matches relative to any ancestor
- **`*.ext`** — suffix-based ignore anywhere in the tree
- **Plain names** — directory or file name match

Rules from `.chronoignore` are merged **after** the default preset, so they can extend but not negate built-in rules.

### Environment variables

| Variable                     | Default              | Description                                                          |
| ---------------------------- | -------------------- | -------------------------------------------------------------------- |
| `PI_CHRONO_HASH_CONCURRENCY` | `8`                  | Max concurrent file hashing operations                               |
| `PI_CHRONO_MAX_FILE_SIZE`    | `104857600` (100 MB) | Files larger than this are skipped                                   |
| `PI_CHRONO_STRICT_HASH`      | `false`              | When `true`, always compute full SHA256 even if `mtime`+`size` match |

### Hashing tradeoff (`mtime` + `size` vs full SHA256)

By default, pi-chrono uses an **optimistic caching** strategy:

- When a file's `mtime` (modification time) and `size` are unchanged between turns, the file is considered **unchanged** and its previous SHA256 hash is reused.
- Only files where `mtime` or `size` differ are re-hashed to detect content changes.

**Why**: In normal AI turns, the vast majority of files are not touched — re-hashing every file after every turn would be wasteful.

**Edge case**: On some filesystems, `mtime` resolution is limited (e.g., FAT32: 2 seconds, HFS+: 1 second). A file could be modified twice within the same clock tick, producing identical `mtime` + `size` but different content.

- **Default (fast)**: Trust `mtime` + `size` — sufficient for virtually all real-world workflows on NTFS, APFS, ext4, etc.
- **Strict mode**: Set `PI_CHRONO_STRICT_HASH=1` to always compute the full SHA256, eliminating the edge case at the cost of performance.

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
├── checkpoints.ts      # Checkpoint listing and user-message entry type guard
├── commands.ts         # Chrono command parsing (subcommands: status)
├── config.ts           # Centralized configuration (concurrency, file size, strict hash)
├── diff.ts             # Diff summary and content diff generation
├── fs-utils.ts         # File system walking, hashing (SHA256), blob ingestion, mapLimit
├── ignore.ts           # Ignore system: IgnoreMatcher, default presets, .chronoignore parser
├── index.ts            # Extension entry point, event handlers, command registration
├── journal.ts          # File operation tracking, reversal, and blob management
├── paths.ts            # Directory constants, session path resolution, storage root setter
├── rollback-preview.ts # Rollback preview builder (operations, validation)
├── state.ts            # Checkpoint and pending-pre persistence (load/save)
├── status.ts           # Status report generation (checkpoint validity, disk stats)
├── types.ts            # Data structures (Checkpoint, Journal, PreManifest, etc.)
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
