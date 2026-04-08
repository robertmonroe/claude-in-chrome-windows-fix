#!/usr/bin/env node
// SessionStart hook: ensure the J51() Windows patch is present in Claude Code's cli.js.
//
// Background
// ----------
// In cli.js 2.1.96, the Chrome MCP connector factory reads:
//
//   function J51(q){return q.bridgeConfig?RO8(q):q.getSocketPaths?Oy7(q):EO8(q)}
//
// `createChromeContext` unconditionally sets `bridgeConfig`, so every platform
// takes the cloud WebSocket bridge path (RO8 → wss://bridge.claudeusercontent.com)
// and never tries the local socket pool (Oy7 → \\.\pipe\claude-mcp-browser-bridge-<user>).
// On Windows with same-machine Chrome the cloud path's `list_extensions` returns
// empty for the account and all `mcp__claude-in-chrome__*` calls fail with
// "Browser extension is not connected", even when the local pipe is healthy.
//
// The one-line fix is to prefer the local socket pool on Windows:
//
//   function J51(q){if(process.platform==="win32"&&q.getSocketPaths)return Oy7(q);return q.bridgeConfig?RO8(q):q.getSocketPaths?Oy7(q):EO8(q)}
//
// Because cli.js is a single bundled file that Claude Code replaces in-place on
// every auto-update, the patch is ephemeral. This SessionStart hook re-applies
// it when missing so the NEXT session after an update starts with working tools.
//
// See: https://github.com/anthropics/claude-code/issues/23828
//
// Behavior
// --------
//   already-patched        → silent no-op (normal steady state)
//   reapplied              → patch was missing, re-applied with timestamped backup
//   needs-manual-intervention → original J51 target string not found; minified
//                               names likely drifted in a Claude Code update and
//                               the patch constants need to be re-derived
//   skipped-non-windows    → only Windows is affected
//   cli-not-found          → could not locate cli.js
//
// Every run writes a single-line JSON status to:
//   ~/.claude/cache/claude-in-chrome-patch.json
//
// The hook NEVER writes to stdout/stderr on success (SessionStart hook stdout
// can pollute the Claude Code session) and ALWAYS exits 0, so a drifted target
// string never breaks the hook pipeline — check the status file if Chrome tools
// start failing after an update.
//
// IMPORTANT: SessionStart hooks run AFTER cli.js is already loaded in memory,
// so this hook heals the *next* session, not the current one. After a Claude
// Code auto-update, Chrome tools may still fail in the first session — restart
// Claude Code once and they'll come back.

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execSync } = require("node:child_process");

const BACKUP_DIR = path.join(os.homedir(), ".claude", "backups");
const CACHE_DIR = path.join(os.homedir(), ".claude", "cache");
const STATUS_FILE = path.join(CACHE_DIR, "claude-in-chrome-patch.json");

// ---- Patch constants (update these when minified names drift) ----------------

const ORIGINAL =
  "function J51(q){return q.bridgeConfig?RO8(q):q.getSocketPaths?Oy7(q):EO8(q)}";
const PATCHED =
  'function J51(q){if(process.platform==="win32"&&q.getSocketPaths)return Oy7(q);return q.bridgeConfig?RO8(q):q.getSocketPaths?Oy7(q):EO8(q)}';
const PATCHED_MARKER = 'process.platform==="win32"&&q.getSocketPaths';

// ---- Utilities --------------------------------------------------------------

function writeStatus(status, extra = {}) {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(
      STATUS_FILE,
      JSON.stringify(
        {
          status,
          checked: Math.floor(Date.now() / 1000),
          ...extra,
        },
        null,
        2,
      ),
    );
  } catch {
    // Nothing sensible to do from a SessionStart hook if even the status
    // write fails. Stay silent.
  }
}

function findCliJs() {
  // Primary: ask npm where its global root is. Works across nvm-windows,
  // volta, plain npm, and non-default prefixes.
  try {
    const npmRoot = execSync("npm root -g", {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    }).trim();
    if (npmRoot) {
      const p = path.join(
        npmRoot,
        "@anthropic-ai",
        "claude-code",
        "cli.js",
      );
      if (fs.existsSync(p)) return p;
    }
  } catch {
    // npm not on PATH or errored — fall through to heuristic search.
  }

  // Fallbacks: common Windows npm-global layouts.
  const candidates = [
    process.env.APPDATA &&
      path.join(
        process.env.APPDATA,
        "npm",
        "node_modules",
        "@anthropic-ai",
        "claude-code",
        "cli.js",
      ),
    path.join(
      os.homedir(),
      "AppData",
      "Roaming",
      "npm",
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "cli.js",
    ),
  ].filter(Boolean);

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ---- Main -------------------------------------------------------------------

function main() {
  if (process.platform !== "win32") {
    writeStatus("skipped-non-windows");
    return;
  }

  const cliPath = findCliJs();
  if (!cliPath) {
    writeStatus("cli-not-found");
    return;
  }

  const text = fs.readFileSync(cliPath, "utf8");
  const origHash = crypto.createHash("sha256").update(text).digest("hex");

  if (text.includes(PATCHED_MARKER)) {
    writeStatus("already-patched", {
      cliPath,
      sha256: origHash.slice(0, 16),
    });
    return;
  }

  const occurrences = text.split(ORIGINAL).length - 1;
  if (occurrences === 0) {
    writeStatus("needs-manual-intervention", {
      cliPath,
      sha256: origHash.slice(0, 16),
      reason:
        "original J51() target string not found; cli.js likely updated — re-derive patch constants against the new minified symbols",
    });
    return;
  }
  if (occurrences > 1) {
    writeStatus("aborted-multiple-matches", {
      cliPath,
      sha256: origHash.slice(0, 16),
      occurrences,
    });
    return;
  }

  try {
    if (!fs.existsSync(BACKUP_DIR))
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(
      BACKUP_DIR,
      `cli.js.${ts}.plugin.bak`,
    );
    fs.copyFileSync(cliPath, backupPath);

    const patched = text.replace(ORIGINAL, PATCHED);
    if (
      patched === text ||
      patched.length !== text.length + (PATCHED.length - ORIGINAL.length)
    ) {
      writeStatus("aborted-unexpected-size-delta", {
        cliPath,
        sha256: origHash.slice(0, 16),
      });
      return;
    }

    fs.writeFileSync(cliPath, patched, "utf8");

    const verify = fs.readFileSync(cliPath, "utf8");
    if (!verify.includes(PATCHED_MARKER) || verify.includes(ORIGINAL)) {
      writeStatus("aborted-verify-failed", {
        cliPath,
        sha256: origHash.slice(0, 16),
      });
      return;
    }

    const newHash = crypto.createHash("sha256").update(verify).digest("hex");
    writeStatus("reapplied", {
      cliPath,
      preSha256: origHash.slice(0, 16),
      postSha256: newHash.slice(0, 16),
      backup: backupPath,
    });
  } catch (err) {
    writeStatus("error", {
      cliPath,
      message: String(err && err.message),
    });
  }
}

try {
  main();
} catch {
  // Never fail the hook pipeline. Status file (if writable) tells the story.
}
process.exit(0);
