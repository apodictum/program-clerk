# program-clerk — AI Agent Rules

## Project identity

The public marketplace for Program Clerk's Claude Code plugins, and the `program-clerk` plugin
itself: the MCP connection to an account (`plugins/program-clerk/.mcp.json`), the hooks every
session runs (`plugins/program-clerk/hooks/hooks.json`), and the skills
(`plugins/program-clerk/skills/`). The server is a separate, private product; nothing here is server
code.

## Critical rules

- **The plugin's scripts use Node's built-in modules only.** Claude Code installs a plugin by
  copying its folder and runs no `npm install`, so `plugins/program-clerk/` has no dependencies. The
  repository's `devDependencies` serve the tests and the formatter.
- **Every hook is exec form:** `"command": "node"` with the script in `args` under
  `${CLAUDE_PLUGIN_ROOT}`, and an explicit `timeout`. It runs the same under Git Bash, PowerShell,
  or no shell.
- **Every hook fails open.** A missing key, an unreachable server, an answer it can't read, or a
  folder outside a checkout means no output and exit 0. The one block is the edit gate's exit 2 for
  a lease another holder has. A hook's calls stop by `HOOK_BUDGET_MS`, under its 5 s timeout, with
  two exceptions that read GitHub for `/pickup`: `digest-prepare.mjs` runs in the background at a
  fresh start, and `digest.mjs` runs on the prompt `/pickup`, each with a 60 s timeout, since a
  collection takes seconds. Every other prompt leaves `digest.mjs` before its modules load.
- **A hook never waits out an outage; a script does.** The hooks' `call` tries once while another
  call's outage mark stands. A script's `request` waits until the outage's first failure, which the
  mark holds for every process, plus its window: 90 s run alone, 3 s under a hook.
- **Lines a session reads start with `[pc]`.** No shipped text names the product's earlier name, a
  machine, or an internal decision; `tests/test-checkout.mjs` checks the shipped files and the
  documents.
- **The lease key has two forms, and both sides must compute the same one.** Repository mode:
  `repo:<remote>`; checkout mode: `repo:<remote>@<host>:<path>`; no remote: `repo:<host>:<path>`.
  `<remote>` is `normalizeRemote` over `git remote get-url origin`, `<host>` is the short host name,
  `<path>` is the checkout's real path with forward slashes. The handoff address is `repo:<remote>`
  in both modes.
- **Every call sends `User-Agent: program-clerk-plugin/<version>`**, the version read from
  `plugin.json`: bump the manifest's version with a release, and the server counts calls by it.
- **Split text on `/\r?\n/`**, never on `'\n'`: the tests run on Windows.

## Code style

- Prettier: 100 characters, single quotes, no bracket spacing, no trailing commas, arrow parens
  "avoid" (`.prettierrc`).
- ES modules, `.mjs`. No comments that narrate the code; a comment is a short note of why.

## Layout

- `.claude-plugin/marketplace.json`: the marketplace.
- `plugins/program-clerk/`: the plugin. `skills/` holds one folder per skill; `scripts/hooks/` holds
  one file per hook; `scripts/digest.mjs` is `/pickup`'s script; `scripts/lib/` holds what they
  share: `common.mjs` (settings, paths, the holder id), `http.mjs` (a hook's `call` and a script's
  `request`, with their retries), `checkout.mjs` (a checkout's top, remote, keys, project),
  `lease.mjs` (the mode, tokens, claims, releases, and the lines), `brief.mjs` (the session-start
  lines), `notices.mjs`, `transcript.mjs`, and `/pickup`'s: `digest-run.mjs` (what it gathers and
  does), `digest.mjs` (its text), `style.mjs`, `queue.mjs` (the project's queue and trackers),
  `drift.mjs` (a checkout against its baseline), `github.mjs` (a repository collected from GitHub).
- `tests/`: tape-six tests. `helpers.mjs` runs a hook as Claude Code does and serves a fake API that
  keeps leases by the server's rules.

## Commands

- `npm test`: every test file.
- `npm run lint` / `npm run lint:fix`: Prettier.
- `claude plugin validate .` and `claude plugin validate plugins/program-clerk`: the manifests.
