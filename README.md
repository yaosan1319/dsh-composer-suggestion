# dsh-composer-suggestion

ChatGPT-style suggested continuation inside the DSH composer: grey ghost text
appears where you are typing, and **Tab** fills it in.

## What it does

| Draft state | Surface | Activation |
|---|---|---|
| Non-empty | Inline ghost text at the caret, with a `Tab` badge | `Tab` completes, `Esc` ignores |
| Empty | A `↳ …` recommendation pill under the composer card | click it, or `Tab` while the editor has focus |

Both surfaces are driven by the model configured for the profile: the plugin's
Host half reads the last few messages of the current Session, asks the model for
either a continuation of your draft or the next prompt you might send, and the
Client half renders the answer. A built-in phrase bank renders instantly and
stays as the fallback whenever the Host is unreachable, slow, or returns
nothing — so the interaction never blocks on the network.

## Install

From a marketplace entry, or directly:

```sh
dsh plugin install dsh-composer-suggestion
```

Or from this directory, from the Harness agent: the bundle is installable with
the plugin manager (`install_bundle`, target = this directory).

## How it wires into DSH

- Client: `conversation.input.overlay` (inline ghost) and
  `conversation.composer.dock` (empty-draft recommendation), registered through
  `ctx.slots`.
- Client insertion: `inputActions.captureInsertion()` plus
  `inputActions.insertText(text, span)` — an ordinary undoable draft edit, so the
  filled suggestion behaves like typing.
- Host: one loopback route `POST /dsh-composer-suggestion/suggest` registered
  with `ctx.webServer.register`, which reads the transcript through
  `ctx.sessions.get(id).snapshotEvents()` and streams a model answer with
  `ctx.llm.stream`.

## Request shape

```json
{ "mode": "continuation", "draft": "把刚才", "language": "zh", "sessionId": "session-…" }
```

Response: `{ "mode": "continuation", "text": "…" }`. The route requires the
`x-composer-suggestion: 1` header, sends no CORS headers, and answers `405`
otherwise.

## Privacy and cost

Each suggestion is one small model call against the profile's default model,
budgeted at 9 seconds; a recommendation is cached per Session for 45 seconds so
focus changes do not re-bill. Nothing is written to the Session log, and the
draft is only sent when it is idle. The route is bound to the loopback web
server; it has no authentication of its own beyond the header above.

## Compatibility

Requires `dsh >= 0.2.1` (the `conversation.input.overlay` and
`conversation.composer.dock` slots plus the `inputActions` draft API).

## License

MIT
