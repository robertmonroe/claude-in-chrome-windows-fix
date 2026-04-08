# Claude in Chrome — Windows Fix

*cli.js breaks claude-in-chrome on Windows every time it updates. This plugin patches it on every session start so Chrome tools just work.*

## The Problem

On Windows, every `mcp__claude-in-chrome__*` call fails with `Browser extension is not connected` — even when the extension is signed in, the native host is running, and `\\.\pipe\claude-mcp-browser-bridge-<user>` is healthy.

Root cause: the Chrome MCP connector factory in `cli.js` unconditionally prefers the cloud WebSocket bridge (`wss://bridge.claudeusercontent.com`) and has no fallback to the local socket pool. The cloud path fails (`list_extensions` returns empty for the account) and there's nothing to catch it. See [anthropics/claude-code#23828](https://github.com/anthropics/claude-code/issues/23828) for the full diagnosis.

## The Solution

A `SessionStart` hook that:

- Locates `cli.js` via `npm root -g`
- Checks whether the Windows fix marker is already present
- If missing, backs up `cli.js` and applies a one-line patch that forces the local socket pool on Windows
- Self-heals across Claude Code auto-updates — no manual re-patching after every release
- Pure no-op on macOS and Linux

Every run writes a status blob to `~/.claude/cache/claude-in-chrome-patch.json` so you can tell at a glance whether everything's healthy.

## How It Works

**The patch.** In `cli.js` 2.1.96 the connector factory reads:

```js
function J51(q){return q.bridgeConfig?RO8(q):q.getSocketPaths?Oy7(q):EO8(q)}
```

where `RO8` is the cloud `BridgeClient` and `Oy7` is the local socket pool. The plugin rewrites it to:

```js
function J51(q){if(process.platform==="win32"&&q.getSocketPaths)return Oy7(q);return q.bridgeConfig?RO8(q):q.getSocketPaths?Oy7(q):EO8(q)}
```

Non-Windows behavior is unchanged.

**The hook.** Runs on every `SessionStart`. If the patch marker is already present, it's a silent no-op. If not, it takes a timestamped backup (`~/.claude/backups/cli.js.<timestamp>.plugin.bak`), applies the textual replacement, verifies the write, and records the result.

**Heals the next session, not the current one.** SessionStart hooks run *after* `cli.js` is already loaded in memory, so the plugin heals the session that follows a Claude Code update, not the one triggering it. If Chrome tools fail immediately after an update, restart Claude Code once — they'll come back.

## Status Reference

`cat ~/.claude/cache/claude-in-chrome-patch.json` — the `status` field tells you what happened on the last run.

| Status | Meaning |
|---|---|
| `already-patched` | Everything is fine. Steady state. |
| `reapplied` | Patch was missing (likely a Claude Code update), it was re-applied, `cli.js` is fixed for the next session. |
| `needs-manual-intervention` | Minified symbol names in `cli.js` drifted in an update. Re-derive the patch constants. See [Updating](#updating). |
| `skipped-non-windows` | Running on macOS or Linux. Nothing to fix. |
| `cli-not-found` | Couldn't locate `cli.js`. Unusual install layout? |
| `aborted-multiple-matches` | Target string appears more than once. Aborted for safety. |
| `error` | Unexpected failure. See `message` field. |

## Installation

### Via Claude Code marketplace

```
/plugin marketplace add https://github.com/robertmonroe/claude-in-chrome-windows-fix
/plugin install claude-in-chrome-windows-fix
```

Restart Claude Code so the hook fires on the next session.

### Local path (for testing or development)

```
git clone https://github.com/robertmonroe/claude-in-chrome-windows-fix.git
claude --plugin-dir ./claude-in-chrome-windows-fix
```

## Updating

When Claude Code ships a new `cli.js` bundle with reshuffled minified names, the hook will record `needs-manual-intervention` and Chrome tools will start failing again. To fix:

1. Open `cli.js` — path is in the status file's `cliPath` field.
2. Search for `bridgeConfig?`. You want a tiny factory function of the shape `function XXX(q){return q.bridgeConfig?YYY(q):q.getSocketPaths?ZZZ(q):WWW(q)}` where `YYY` is the cloud `BridgeClient` and `ZZZ` is the local socket pool.
3. Update the `ORIGINAL`, `PATCHED`, and `PATCHED_MARKER` constants at the top of `hooks/claude-in-chrome-patch.js` to match the new minified names.
4. Commit, push, bump the plugin version.

The *shape* of the factory (`bridgeConfig ? X : getSocketPaths ? Y : Z`) is stable across minifier runs even when the symbol names churn — that's what makes the textual patch viable across versions.

## Rollback

Every patch takes a backup first. To roll back:

```
cp ~/.claude/backups/cli.js.<timestamp>.plugin.bak "$(npm root -g)/@anthropic-ai/claude-code/cli.js"
```

Uninstall the plugin afterward to prevent it from re-applying on the next session:

```
/plugin uninstall claude-in-chrome-windows-fix
```

## Credits

First documented for `cli.js` 2.1.76 by [@cruzlauroiii](https://github.com/cruzlauroiii) in [anthropics/claude-code#23828](https://github.com/anthropics/claude-code/issues/23828). Extensive Windows debugging and native-host architecture work by [@bosmadev](https://github.com/bosmadev) in the same thread. This plugin targets the 2.1.96+ variant with reshuffled minified names and keeps the fix self-healing across auto-updates.

## License

MIT. See [LICENSE](LICENSE).
