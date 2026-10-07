# Skills and prompt templates

Every session runs a real pi, so pi's [skills](https://agentskills.io/specification) and prompt templates work as they do in the terminal. The model loads a skill when the task calls for it, and typing `/skill:<name>` or `/<template>` at the start of a message runs it.

The host also shows them to the client:

- **Customizations:** each session lists the skills and prompt templates pi loaded, grouped by the folder they came from (for example `~/.pi/agent/skills` or `~/.agents/skills`). The list is read-only; skills cannot be toggled or added from the client.
- **Completions:** typing `/` at the start of a message suggests matching skills and prompt templates. `/pdf` matches `/skill:pdf`.

## Where pi finds skills

- `~/.pi/agent/skills/` and `~/.agents/skills/` (always).
- `<cwd>/.pi/skills/`, and `.agents/skills/` in the working directory and its parents up to the git root, **only for trusted projects**.
- Paths in the `skills` setting, pi packages, and `--skill` arguments.

See pi's own skills documentation for details.

## Project trust

Sessions the host starts run `pi --mode rpc`, which cannot ask whether to trust a project. Project skills load only if you saved a decision with `/trust` in a pi terminal (stored in `~/.pi/agent/trust.json`) or set `defaultProjectTrust` to `"always"`. Sessions shared from a pi terminal follow the terminal's decision.

## When the list updates

The list is read when pi starts for a session. A session opened from history has no pi yet, so its list appears on the first message or the first `/` completion. Skills added later show up the next time pi starts for that session.

## Troubleshooting: no completions in VS Code

VS Code asks for completions only if the host announced `/` as a trigger character during `initialize`. It keeps that answer across reconnects. Hosts before this fix accepted `reconnect` from clients they had never seen, so a VS Code window that first connected to an older host kept an empty trigger list and never showed suggestions. Current hosts answer such a `reconnect` with `NotFound`, which makes VS Code initialize again. If completions are still missing, reload the VS Code window, or remove and re-add the remote agent host.
