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
   tools send this key, and so do the hooks. The hooks also read `PROGRAM_CLERK_KEY` when the option
   is empty, but the tools don't. A script the agent runs in its shell never sees the option, so at
   each session start the plugin keeps the key in a file only you can read, named by the session,
   under its state folder (`~/.local/state/program-clerk/keys/`), and the plugin's scripts find it
   there. The agent's shell gets neither the key nor the file's path, so the commands it runs, and
   whatever they start, don't carry it. The file goes when the session ends, and one a crashed
   session left goes after 30 days. When `PROGRAM_CLERK_KEY` is set, the plugin writes no file and
   its scripts use the variable.
3. To receive each release, turn on auto-update for the `program-clerk` marketplace in `/plugin`.
   Auto-update is off by default for marketplaces that Anthropic doesn't publish.
4. Start a new session. Its first lines start with `[pc]` and say whether the session holds the
   checkout's lease.

## What the plugin does

- **Connects the account.** The plugin registers the `program-clerk` MCP server at
  `https://api.programclerk.dev/mcp`, so a session can search and edit the account's notes, take and
  release leases, and file handoffs.
- **At session start**, it claims a lease on the checkout the session starts in, prints a brief of
  the account and the project with any service notices, prints the project's feedback rules, and
  keeps the key where the plugin's scripts find it.
- **Before an edit** through the Edit, Write, MultiEdit, or NotebookEdit tool, it checks the lease
  of the checkout that holds the file. An edit into a checkout that another session holds is
  blocked, with the steps to do the work in a worktree and hand it over instead.
- **After each tool call**, it renews the session's lease every 15 minutes and passes on new service
  notices.
- **At session end**, it releases the session's leases, records what the session did for the next
  session's brief, and removes the key's file.
- **On `/pickup`** (or `/program-clerk:pickup`), it shows a digest of the project: how the last
  session finished, what is upcoming and open, drift in the checkout since its recorded baseline,
  the project's GitHub threads, and the notes changed since the last session. At a fresh start it
  collects the checkout's GitHub repository in the background, so the digest arrives in about a
  second.
- **On `/wrap`** (or `/program-clerk:wrap`), the agent saves what the session learned to the
  project's notes, writes the session's log, and records the checkout's state for the next
  `/pickup`.
- **The `queue` skill** gives the agent the project's queue: list, file, move, and archive items,
  and show where the project's work is tracked.

Every hook fails open: when the server is unreachable or the key is missing, a hook stays silent and
the session goes on.

## /pickup

`/pickup` brings the agent up to speed on the project the session runs in, and stops: what to work
on next is yours to say. `/program-clerk:pickup` always reaches it, should Claude Code ever add a
command of the same name. The digest's sections:

- **How we finished:** the last session log's title and summary, and any session that ended after it
  with no log of its own.
- **Upcoming:** the log's next steps, the queue's Active items, the plan or the first Backlog items,
  and what entered the Backlog since the last session.
- **Open:** the log's open questions, handoffs waiting, items that mirror a ticket, the Inbox, and
  the checkout's drift: commits, tags, and npm publishes since its baseline, unpushed commits, the
  working tree, and git tags without a publish.
- **Outside:** the project's trackers, and for its GitHub repository the last CI result, what moved
  since the last look, and each open thread's title.
- **Changed since the last session:** the notes written since, by title.

Reading GitHub needs the [`gh` command](https://cli.github.com/) signed in; without it, the digest
says so and shows the last stored view. A new issue, pull request, or discussion a person opened,
and a CVE that lands on an advisory, are filed on the project's queue in the section its GitHub
tracker names, and the GitHub baseline then moves forward, so the next digest shows only what moved
after it. The last CI result is the default branch's newest run, or a newer pull request's run when
one was merged after it, as for a repository that tests pull requests alone.

A private repository is read only when the project's trackers name it, so the digest says when the
checkout's repository is private and untracked. To track it, list it in the frontmatter of
`projects/<project>/queue/_about.md`, beside the queue's own entry, which stays primary:

```yaml
trackers:
  - {kind: 'vault', role: primary}
  - {kind: github, ref: owner/repo, intake: triage}
```

`intake: triage` files a person's new threads in the Inbox; leave it out to list them without
filing.

When the trackers name Linear or Jira, the digest names the tracker, and the agent reads its open
items updated since the last session through that tracker's tools, such as its MCP server, when the
session has them. It files none of them on the queue.

## /wrap

`/wrap` ends a stretch of work: a session can wrap more than once. The agent saves what the session
learned to the project's notes (rules, decisions, lessons, and work for the queue), then writes a
file with the log's title, summary, and body, and runs the plugin's `wrap.mjs` on it. The script
writes the log, adds its line to the project's month of sessions, and records the checkout's state
in `projects/<project>/state.md`. The next `/pickup` shows the log's open items and next steps as
written, and reports what moved in the checkout since.

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

| Variable            | Use                                                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| `PROGRAM_CLERK_KEY` | The key when the plugin's key option is empty; the plugin's scripts read it before the session's key file. |
| `PROGRAM_CLERK_URL` | The address the hooks and scripts call. The default is `https://api.programclerk.dev`.                     |
| `XDG_CACHE_HOME`    | Where the hooks keep their cache (`program-clerk/` under it).                                              |
| `XDG_STATE_HOME`    | Where the hooks keep claim tokens, unfinished releases, and each session's key file.                       |

Without the `XDG_` variables, the hooks use `~/.cache/program-clerk/` and
`~/.local/state/program-clerk/`.

A running session keeps the key it started with. After you replace a key, start a new session.

## License

Apache-2.0. For more information, see [LICENSE](./LICENSE).
