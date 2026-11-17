# Contributing to the Program Clerk plugins

Thank you for your interest in contributing!

## Discuss significant changes first

Every significant change starts as a conversation. Before you write code, open an
[issue](https://github.com/apodictum/program-clerk/issues) that describes the problem and the change
you propose, and wait for a maintainer to approve it explicitly. A pull request for a significant
change that wasn't discussed and approved first isn't merged, and may be closed without review.

A significant change is anything beyond a small fix: a new feature or option, a change to documented
behavior, a new dependency, a refactor, or a change to the tests or CI. Small fixes can go straight
to a pull request: a typo, a broken link, or a bug fix of a few lines with a test that fails without
it.

The discussion saves your time as much as ours: a change that doesn't fit the project is cheaper to
turn down before it is written. Approval covers the plan you described, and the pull request is
still reviewed against it.

### What a change has to fit

- **The project's purpose.** The plugin connects Claude Code to a Program Clerk account and runs the
  hooks that keep its leases. A change that serves one setup's special needs belongs in a fork you
  maintain yourself.
- **The cost of keeping it.** A merged change is maintained here from then on. A change has to be
  worth that cost, and a feature can be declined for that reason alone.
- **No dependencies in the plugin.** Claude Code copies the plugin's folder and installs nothing, so
  its scripts use Node's built-in modules only.
- **One concern per pull request.** A pull request that mixes several changes goes back to its
  author to be split.

## Development workflow

```bash
git clone https://github.com/apodictum/program-clerk.git
cd program-clerk
npm install
```

1. Make your changes.
2. Format: `npm run lint:fix`
3. Test: `npm test`
4. Check the manifests: `claude plugin validate .`

## License

This project is distributed under the [Apache-2.0 license](./LICENSE). By submitting a contribution,
you agree that it is licensed under the same terms.

## AI agents

If you are an AI coding agent, see [AGENTS.md](./AGENTS.md) for the project's rules and conventions.
