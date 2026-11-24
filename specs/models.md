# Spec: The model list

## Problem

VS Code's model picker shows the models the host publishes in the root state (`root/agentsChanged`, the pi agent's `models`). The host listed models only at startup and when a client connected, and in `rpc` mode through a short-lived `pi --mode rpc` that answers `get_available_models`. When that listing came back empty, the host published the empty list and cached it for 30 s. A client that stayed connected never asked again, so VS Code showed "No models available" until something reconnected or the host restarted, and nothing was logged.

The empty answer is real: Bolt 1.5.0 answered its first `get_available_models` with no models in 3 of 15 fresh starts. Providers that extensions register (Locksmith) are marked available by a background availability check, and a request in the first second can arrive before it finishes. Bolt now waits for that check (cruise/bolt `fix(coding-agent): wait for the first availability check before listing no models`), but the host can't rely on every pi doing so, and a listing can also fail outright (pi crashes, a credential helper hangs).

## Behavior

`src/pi/model-catalog.ts` (`ModelCatalog`), owned by `AgentHost`:

- **Only real lists are published.** A listing that returns no models, or fails, never replaces the published list. Before the first real list the agent's `models` stays empty; afterwards an empty or failed listing keeps the last real one. The host sends root state only when it changed, so an unchanged list is not republished.
- **While the published list is empty**, the host lists again after 2, 4, 8, 16, 30 s, 1, 2, 5 and 10 minutes, then every 10 minutes, until one succeeds. The first real list goes to every connected client through `root/agentsChanged`, so VS Code fills its picker without reconnecting.
- **Once there are models**, the host relists every 10 minutes, so models added upstream (Locksmith) appear without a restart.
- **On demand:** startup and each `initialize` call `refreshAgents()`, which lists now. Listings already in flight are shared, and each listing reschedules the next one.
- **Logging:** each empty listing logs `pi listed no models` at warn, and each failed one `could not list models` (with the error), both with the `attempt` number and how many models are being kept. The first success after failures logs `models available` at info with the `count`.
- **pi can't be started at all** (`PiStartError`, for example `--pi` points at nothing): `refreshAgents()` rejects with it, so the CLI prints "Install pi, pass --pi <path>, or use --pi-mode embedded." and exits. This is the only way `refreshAgents()` rejects; every other model failure is logged and retried.
- **A listing that never finishes** (a credential helper hangs) counts as failed after 30 s: it is logged as `could not list models` (`listing models timed out after 30000 ms`), aborts the `AbortSignal` passed to `PiBackend.models`, and goes back on the backoff. In `rpc` mode, aborting closes and kills the short-lived `pi` child and its process group, so hung children do not accumulate. `ModelCatalog.dispose()` also aborts any in-flight listing.
- **RPC backend:** `get_available_models` answering `[]` is returned as it is (as the embedded backend does), so the catalog logs `pi listed no models`. The backend's 30 s cache keeps real lists only (`cached`'s `shouldCache`), because clients ask on every `initialize`; an empty answer is asked again at the next listing.
- **Customizations** (pi's global commands) are loaded alongside each `refreshAgents()` as before, and published independently of the model listing.

## Trade-offs

- A failed listing after a success keeps showing models that may have gone away (for example, access to one was revoked). Selecting one then fails with pi's own error, which is clearer than an empty picker.
- Timings are fixed (`AgentHostOptions.modelRetryDelaysMs`, `modelRefreshIntervalMs` and `modelListTimeoutMs` override them for tests).

## Tests

`test/model-catalog.test.ts`:
- the backoff (2, 4, 8, 16, 30 s, 1, 2, 5 and 10 minutes, then 10 minutes);
- empty, failed and real listings are told apart, and a listing that never finishes counts as failed and aborts its signal (a hung listing is logged, clears the in-flight listing and the retry succeeds);
- `ModelCatalog.dispose()` aborts an in-flight listing;
- a hung `RpcBackend` model listing kills the `pi` child and its subprocesses at the deadline;
- with a backend that answers empty, fails, empty, then two models: nothing is published until the real list, the retries follow the backoff, the periodic refresh takes over, and warnings and the recovery are logged;
- a later empty or failed listing keeps the list, and later real lists are handed on for publishing (the host sends root state only when it changed);
- concurrent refreshes share one listing, and dispose stops the schedule;
- end to end with `AgentHost` and a WebSocket client: the client initializes while the list is empty and gets the models published without reconnecting;
- an `RpcBackend` over a script answering `[]` then a model: the catalog logs `pi listed no models` and the empty answer isn't cached;
- `refreshAgents()` rejects with `PiStartError` when pi can't be started.

`test/cached.test.ts`: a result `shouldCache` rejects is returned but loaded again next time.
