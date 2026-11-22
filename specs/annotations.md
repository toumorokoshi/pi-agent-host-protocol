# Spec: Review comments (annotations)

## Problem

VS Code's Agents window has no "add selection to chat". To point the agent at code, you select lines in a changed file, add a comment, and click Submit. For agent-host sessions VS Code keeps those comments on the session's annotations channel and submits them as a `/act-on-feedback` message. This host had no annotations channel, so VS Code fell back to keeping comments in the window only: they did not survive a window reload, and the agent could never mark them resolved.

AHP 1.1 defines a per-session annotations channel. VS Code finds it through `SessionSummary.annotations.resource` and uses it only when a host advertises it.

## Behavior

- **Channel** (`src/core/uris.ts`, `src/core/state-store.ts`): every session has one at its session URI plus `/annotations` (`pi:/<id>/annotations` or `ahp-session:/<id>/annotations`, matching the scheme the session is published under). Its state is `AnnotationsState`, reduced with the protocol's `annotationsReducer`.
- **Advertised:** the session state and every session summary (live sessions and ones listed from disk) carry `annotations: { resource, annotationCount, entryCount }`. A change to the channel publishes the new counts with `root/sessionSummaryChanged`.
- **Client actions:** all five annotations actions (`annotations/set`, `updated`, `removed`, `entrySet`, `entryRemoved`) are accepted. Other actions on the channel are rejected. Subscribing to the channel of a saved session loads that session, as subscribing to its session or chat URI does.
- **Persistence** (`src/host/annotation-store.ts`): each session's annotations are saved in `annotations.json`, next to `settings.json`, after every change, with the same write behavior as the archive file. Sessions without annotations are left out, and disposing an unused session drops its entry. `AgentHost` is the only writer: a listener on the state store saves a session's annotations after every annotations-channel action, whether a client or the host (`#resolveComments`) dispatched it. `PiSession` gets a read-only view (`annotationsOf`). Archived flags differ because `PiSession` writes them itself, as it alone sees the actions that change them.
- **Submitting** (`src/pi/annotations.ts`): VS Code sends `/act-on-feedback` with one annotations attachment (`displayKind: "agentFeedback"`) per comment, naming its annotation id. For a turn's message, the host:
  - looks up each named comment on the session's channel (an attachment without ids names every unresolved comment); a comment the channel does not have, or one on another channel, is read from the attachment's `_meta.agentFeedback.feedbackItems`;
  - adds them to the prompt after the message and its attachments:

    ````
    Review comments:

    src/app.ts:3-4
    Selection:
    ```
    const x = 1;
    ```
    Comment (user): Rename this
    Reply (agent): Done?
    ````

    Paths are relative to the session's folder when inside it. Lines are 1-based. The selection and diff come from VS Code's feedback `_meta` when present, and authors from each entry's `_meta`;
  - replaces the bare `/act-on-feedback` text with "Address the review comments below.", since pi has no such command.
- **Resolving:** when the turn completes (not on an error or a cancel), the host marks the comments it acted on resolved with `annotations/updated`. VS Code then hides them.
- **Fallback:** when VS Code has no channel, it sends the comments inline as a simple attachment with their text as its model representation; the host passes that to pi as before.

## Trade-offs

- **VS Code's `_meta` keys:** the attachment's `displayKind: "agentFeedback"`, its `_meta.agentFeedback` and the annotations' `_meta["vscode.agentFeedback"]` are VS Code's own, not AHP's (`src/pi/annotations.ts`). Like the completion `_meta` shapes, they couple the host to VS Code; a comment without them still reaches pi with its text and range, and the channel's own annotation is preferred over the attachment's copy. See GAPS.md.
- **No comment tools:** VS Code's own host gives its agent `listComments`, `replyToComment` and `addComment`. pi gets the comments as prompt text instead, so it cannot reply to a thread or leave comments of its own.
- **Resolved on completion:** a completed turn does not prove that every comment was addressed. Resolving is the only signal VS Code has that the agent finished with them; the user can re-open a comment.

## Tests

`test/annotations.test.ts`:
- Channel URI shapes, the annotation file's format, and a file store that persists and reloads.
- Prompt text for comments from the channel (file, lines, selection, thread), all unresolved comments when no ids are named, comments read from the attachment, another session's channel, and repeats.
- End to end in both pi modes: the advertised summary, a client's `annotations/set` and the count notification, rejected actions, a submit whose prompt holds the comment and whose completed turn resolves it, and a failed turn that leaves it open.
- A restarted host lists the saved count and serves the saved comments, loading the session on subscribe.
