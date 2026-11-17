# Program Clerk for Claude Code

The Program Clerk plugin connects Claude Code to your Program Clerk account. Your agents share notes
across projects, machines, and sessions, take a lease on the checkout they work in so that two
agents don't edit one working tree at once, and hand work to each other when they can't. The plugin
brings the account's MCP tools into every session and runs the hooks that keep those leases and tell
each session where it stands.

## Install

You need Node.js and git on your `PATH`: the hooks run `node` and read your checkouts with `git`.

1. In Claude Code, add the marketplace and install the plugin:

   ```text
   /plugin marketplace add apodictum/program-clerk
   /plugin install program-clerk@program-clerk
   ```

2. When Claude Code asks for the plugin's **Program Clerk key**, paste an API key from your
   account's Keys page. Claude Code keeps it in your system's credential store. The plugin's MCP
   tools send this key. The hooks also read `PROGRAM_CLERK_KEY` when the option is empty, but the
   tools don't.
3. To receive each release, turn on auto-update for the `program-clerk` marketplace in `/plugin`.
   Auto-update is off by default for marketplaces that Anthropic doesn't publish.
4. Start a new session. Its first lines start with `[pc]` and say whether the session holds the
   checkout's lease.

## What the plugin does

- **Connects the account.** The plugin registers the `program-clerk` MCP server at
  `https://api.programclerk.dev/mcp`, so a session can search and edit the account's notes, take and
  release leases, and file handoffs.
- **At session start**, it claims a lease on the checkout the session starts in, prints a brief of
  the account and the project with any service notices, and prints the project's feedback rules.
- **Before an edit** through the Edit, Write, MultiEdit, or NotebookEdit tool, it checks the lease
  of the checkout that holds the file. An edit into a checkout that another session holds is
  blocked, with the steps to do the work in a worktree and hand it over instead.
- **After each tool call**, it renews the session's lease every 15 minutes and passes on new service
  notices.
- **At session end**, it releases the session's leases and records what the session did, for the
  next session's brief.

Every hook fails open: when the server is unreachable or the key is missing, a hook stays silent and
the session goes on.

## Leases

A lease names one holder for a working tree. The first session in a checkout holds it, a second
session there is subordinate (it reads freely and sends its edits as a handoff), and a lease left
unrenewed for an hour passes to the next session that starts in the checkout.

Your account chooses what a lease covers, for every member at once:

- **`checkout`** (the default): each clone has its own lease, keyed by its host and path. Members
  who each work in their own clone never wait for each other, and git brings their work together
  through branches and pull requests.
- **`repository`**: one lease covers every clone of a repository on every machine, keyed by its
  remote. Work from another clone arrives at the holder as a handoff. This mode suits one person who
  keeps one line of history across several machines.

To choose `repository`, create the note `program-clerk/settings.md` in your account with this
frontmatter:

```markdown
---
title: Program Clerk settings
type: meta
leases: repository
---
```

Each session reads the setting when it starts and keeps it until it ends. A session that can't read
the setting uses the value it read last on that machine, or `checkout`.

Handoffs are addressed to the repository (`repo:github.com/OWNER/NAME`) in both modes, so any
session working in a clone of it can take one.

### What the gate doesn't check

The hook checks the edit tools only. A write through a shell command isn't checked: before an agent
writes into a checkout that way, it claims the lease with `lease_claim` and acts on the answer. On
Windows, the same holds for the PowerShell tool.

## Settings

| Variable            | Use                                                                        |
| ------------------- | -------------------------------------------------------------------------- |
| `PROGRAM_CLERK_KEY` | The hooks' key, when the plugin's key option is empty.                     |
| `PROGRAM_CLERK_URL` | The address the hooks call. The default is `https://api.programclerk.dev`. |
| `XDG_CACHE_HOME`    | Where the hooks keep their cache (`program-clerk/` under it).              |
| `XDG_STATE_HOME`    | Where the hooks keep claim tokens and unfinished releases.                 |

Without the `XDG_` variables, the hooks use `~/.cache/program-clerk/` and
`~/.local/state/program-clerk/`.

A running session keeps the key it started with. After you replace a key, start a new session.

## License

Apache-2.0. For more information, see [LICENSE](./LICENSE).
