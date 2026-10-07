# Spec: Skills and prompt templates

## Problem

Skills already worked through the host: pi lists them in the system prompt, and `/skill:name` in a message is expanded by pi. A client could not see them, though. VS Code could not list the skills a session has, and offered no completion when typing `/`, so users had to know skill names in advance.

AHP has both pieces: `SessionState.customizations` (directory containers holding `SkillCustomization` and `PromptCustomization` children) and the `completions` command with `InitializeResult.completionTriggerCharacters`.

## Behavior

- **Source of truth:** the agent's own command list, `PiAgent.commands()`. It is pi's RPC `get_commands` in rpc mode and through the TUI bridge (which now forwards pi's full `SlashCommandInfo`, not only names). The embedded backend builds the same list from `AgentSession` (extension commands, `promptTemplates`, `resourceLoader.getSkills()`). The list is exactly what pi loaded, so project trust and `--no-skills` are respected.
- **Loading** (`PiSession.#loadCommands`): each time the session observes a new agent (started, restarted after a crash, or a live TUI attached or adopted), the host reads the list and keeps it per session.
- **Mapping** (`src/pi/customizations.ts`, pure functions apart from `withFrontmatter`):
  - `userCommands` keeps skills and prompt templates. Extension commands are dropped: they act on pi's UI and are not customizations.
  - `withFrontmatter` reads each command's frontmatter for what `get_commands` does not carry: `disable-model-invocation` (skills) and `argument-hint` (skills and prompt templates). Unreadable files keep the command unchanged.
  - `containerDir` picks the folder a command was discovered in: `<baseDir>/skills` or `<baseDir>/prompts` when the file is inside it (pi's standard locations, where `baseDir` is `~/.pi/agent`, `<cwd>/.pi`, `~/.agents` or `<dir>/.agents`); otherwise the folder holding the skill directory or template file.
  - `toCustomizations` publishes one `DirectoryCustomization` per folder and kind: `enabled: true`, `writable: false`, `load: loaded`, id `<kind>:<dir>`. Children are sorted by name and use the file URI as id. A skill's name drops the `skill:` prefix.
- **Publishing:** `session/customizationsChanged` with the full list, skipped when it equals the current state.
- **Completions:**
  - `initialize` returns `completionTriggerCharacters: ["/"]`. Clients keep the `InitializeResult` from their first handshake across reconnects (VS Code re-runs `initialize` only when `reconnect` fails with `NotFound`). So `reconnect` from a `clientId` this host instance never initialized (for example after a host restart or upgrade) fails with `NotFound` (`-32008`). Otherwise a client that first connected to an older host would never see the trigger characters, and VS Code would never ask for completions.
  - `completions` with kind `userMessage` on a session or chat channel answers when the text before the cursor is `/` plus a word at the very start of the message, since pi expands commands only there. Items are commands whose name, or skill name without `skill:`, starts with the typed word (case-insensitive), sorted by name.
  - An item replaces `[0, end of word)` with `/<name> ` and carries a `simple` attachment labelled `/<name>` with no model representation, so the prompt sent to pi is unchanged.
  - The attachment's `_meta` (`completionMeta`) uses the shapes VS Code's own agent hosts send, which VS Code reads in `readCompletionAttachmentMeta`:
    - skills: `{ uri, name, displayName, description }`, where `uri` is the `SKILL.md` file URI, `name` the bare skill name and `displayName` the command name (`skill:<name>`). VS Code shows the description next to the item and adds a skill chip.
    - prompt templates: `{ command, description, argumentHint }`. VS Code shows the description and, once the item is accepted, the argument hint as placeholder text.
  - When VS Code sends the message, the accepted chip comes back as a `simple` attachment with no model representation. `promptInput` ignores it, and the `/<name>` text stays in the message for pi to expand.
  - A session without an agent (loaded from disk, never run) starts one on the first completion request, since the list comes from pi.
  - Any failure returns no items; completions are best effort.
- **Not supported:** `session/customizationToggled` stays rejected, because pi cannot disable one skill for a single session. Clients cannot write into the directories (`writable: false`, and `resourceWrite` is refused).

## Trade-offs

- Using the agent's list rather than scanning directories in the host keeps the host in step with pi's discovery rules, at the cost of needing a running agent. Sessions loaded from disk therefore show no customizations until their first turn or completion request.
- The list is read once per agent. pi re-reads resources only on `/reload`, which the host does not observe (see GAPS.md).

## Tests

- `test/customizations.test.ts`:
  - `userCommands`, `containerDir`, `toCustomizations`, `withFrontmatter` and `completionMeta` cases;
  - slash completion matching, ranges, and the start-of-message rule;
  - end to end in both modes: skills and prompts in the agent directory appear in session state, `/` is a trigger character, and `completions` returns them with their `_meta` details.
- `test/e2e.test.ts`: `reconnect` from an unknown client fails with `NotFound`, and the following `initialize` carries the trigger characters.
- `test/extension.test.ts`: the bridge's `get_commands` forwards full command info.
