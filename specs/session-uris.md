# Spec: Session URI schemes

Status: **implemented**.

## Problem

VS Code's Agents window chooses a new session's URI itself, then derives the session's default chat URI from it (`ahp-chat://default/<base64url(sessionUri)>`). It matches the host's `root/sessionAdded` and `root/sessionSummaryChanged` notifications, and the session's chat catalog, against those URIs.

Older VS Code builds created every session as `<provider>:/<id>` (`pi:/<id>`), and the host published every session under `pi:/<id>`. Current builds (seen with 1.147) create sessions as the spec's canonical `ahp-session:/<id>` on any host they do not recognize as VS Code's own (`isNativeAgentHost` and `vscode.ahpSessionUris` in VS Code's `agentHostSessionUrisMeta.ts`). The host accepted that URI but kept publishing `pi:/<id>`, so for each new session:

- the idle `root/sessionSummaryChanged` named a session the client did not know, and the row stayed "Working..." until the window was reloaded;
- the advertised default chat (`base64url("pi:/<id>")`) differed from the one the client derived (`base64url("ahp-session:/<id>")`), so the client showed the session with a second, nested chat.

## Design

- `uris.ts`: `SessionScheme` is `pi` or `ahp-session`. `sessionUri(id, scheme)` and `chatUri(id, scheme)` build a session's URI and its default chat's URI; both default to `pi`. `sessionSchemeOf(uri)` reads the scheme of a session URI.
- `subagentChatUri(sessionResource, chatId)` and `subagentChatSession(uri)` build and read the URI of a subagent chat, `ahp-chat://<chat id>/<base64url(session URI)>`: the shape VS Code gives non-default chats of a session, with a `subagent-` chat id. The session URI can be read back from it, so a subagent chat's URI loads its session after a restart (see [subagents.md](subagents.md)). `ChatRef.chatId` of such a chat is that synthetic id: no pi session backs it.
- `StateStore` takes a `schemeOf(sessionId)` lookup and publishes sessions and default chats with `sessionResource(id)` and `defaultChatResource(id)`. `PiSession` and `AgentHost` publish through these instead of building `pi:/` URIs.
- `createSession` records the scheme of the URI the client created the session with. Sessions the host did not create (pi's existing session files, live terminal sessions) use `pi`, as before.
- Storage (`src/host/scheme-store.ts`): `session-schemes.json`, next to `settings.json`, lists the sessions published under `ahp-session`. It has the same shape and write behavior as the archive file (see [archived-sessions.md](archived-sessions.md)). Without it, a session created as `ahp-session:/<id>` would come back as `pi:/<id>` after a host restart and the client would no longer match it. Disposing an unused session drops its entry.

```json
{
	"version": 1,
	"ahpSession": ["<pi session id>", "…"]
}
```

## Tests

- `scheme-store.test.ts`: URI helpers, parsing and serializing the file, and reloading it.
- End to end, in both modes: a session created as `ahp-session:/<id>` is announced, summarized and listed under that URI, with the default chat the client derived; after a restart it is still listed and loaded under the same URIs, and `pi:/<id>` sessions keep `pi`.
