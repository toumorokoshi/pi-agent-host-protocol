# Spec: Session projects (folder names in the Agents window)

## Problem

VS Code's Agents window names and groups sessions by workspace. For an agent host session, the workspace comes from `SessionSummary.project` when the host sets one (its `displayName` is the label and the folder name), and otherwise from the session's first working directory, labelled by its last path segment (`buildAgentHostSessionWorkspace` in VS Code's `agentHostSessionWorkspace.ts`; `groupByWorkspace` in `sessionsList.ts` groups by that label). The host set no project, so sessions in `~/workspaces/cruise-3/src/github.robot.car/cruise/cruise` and `~/workspaces/automedon-2/src/github.robot.car/cruise/cruise` both showed as `cruise` and landed in one group.

## Behavior

`src/pi/projects.ts` gives every session a `project: { uri, displayName }`, chosen from its working directory by the first rule that applies (`projectFor`, a pure function):

1. **`~/workspaces/<ws>/…`** (a poppy or `cruise` workspace): the workspace, named `<ws>`, e.g. `cruise-3`.
2. **`~/.cache/cfs/workspaces/<name>/worktree/…`** (a CFS workspace): named `<name>`, e.g. `bolt-agents-window`.
3. **Inside a git repository** (the nearest directory at or above the working directory, below home, that holds `.git`, a directory or a worktree's file; home itself never counts, so a dotfiles repository at `~` doesn't put every plain folder under home in one project): the repository, named `<parent>/<repo>`, e.g. `src/pi-agent-host-protocol`.
4. **Anything else:** the directory, named by its path from home (`~/plans`), or its absolute path outside home.

The project is set in the session state, in session summaries (catalog entries and `root/sessionSummaryChanged`), and again when the working directory moves (`session/workingDirectoryReplaced`: the host updates the stored session state, which the SDK reducer leaves alone, and sends the new project in `root/sessionSummaryChanged`). Each directory's project is cached for a minute, in a cache of at most 1,000 directories, since session lists ask for every session. The lookup is synchronous (a few `existsSync` calls per uncached directory), because summaries are built synchronously.

VS Code shows the project's `displayName` as the group and folder name, and puts sessions with the same name in one group.

## Trade-offs

- The rules know this machine's layout (`~/workspaces`, CFS). Other layouts fall back to the git repository or the path, which still tells same-named repositories apart in most cases.
- With a project set, VS Code treats the session's folder as a repository (`Codicon.repo`, git repository `uri` = the project's). For rules 1 and 2 that's the workspace directory, not the repository inside it; nothing the host serves depends on it. This is VS Code's behavior (`buildAgentHostSessionWorkspace`, `groupByWorkspace`), not part of the protocol, so a new VS Code version needs the grouping checked again.
- A forked chat reports its parent session's project through the session; it has no project of its own.

## Tests

`test/projects.test.ts`: each rule (two `cruise` checkouts in different workspaces get different names; CFS; another repository; a plain directory in and outside home), finding a git root (directory, worktree file, none, and a repository at home itself being ignored), the bounded cache, a real session reporting its project in its state and in the catalog, and a moved session (`test/session-move.test.ts`) reporting the new project in its summary and in the state a new subscriber gets.
