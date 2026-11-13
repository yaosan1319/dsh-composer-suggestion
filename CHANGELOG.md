# Changelog

## 1.3.0

Everything below comes from the review in issue #1. Items marked *(behaviour)*
change what a user notices.

> A running Harness desktop process keeps the plugin modules it loaded first:
> installing a new version updates the files on disk, but the Client UI and the
> Host route keep executing the old code until the application restarts.

### Keyboard

- **Tab is no longer swallowed when nothing can be inserted** *(behaviour)*.
  `accept()` reports whether the draft really changed and the handler only calls
  `preventDefault()` on success, so editing mid-sentence and pressing Tab keeps
  the native behaviour instead of dead-keying.
- `insertText` returning nothing counts as success; only an explicit `false` is a
  refusal, so a void-returning API can no longer leave a ghost on screen.
- Tab acceptance tolerates editors that report caret offsets in code points
  rather than UTF-16 units, so an emoji in the draft no longer blocks completion.

### Ghost placement

- **The ghost no longer slides left over typed text** at the right edge of a line
  *(behaviour)*. It is truncated to the room left inside the editor and hidden
  when less than 80 px remain.
- The boundary is the editor's own rectangle instead of `window.innerWidth`, so
  narrow layouts and the right sidebar stay correct.

### Privacy and cost

- **Recommendations require a real interaction with the composer** *(behaviour)*.
  Engagement comes only from a press, key or input whose target is the draft
  editor; opening a session, an auto-focus, or a click in the sidebar never sends
  the transcript, and the pill stays hidden until you touch the input box.
- **Draft text that looks like a credential is never sent** *(behaviour)*: API
  keys, GitHub/AWS tokens, private-key headers and `key: value` patterns are
  refused on both sides.
- Per-session token bucket (30 requests/minute) answering `429` past the limit.
- Suggestions are cached per session, language and mode in a bounded LRU
  (32 entries, 45 s TTL) instead of an unbounded map.
- Drafts are truncated to 400 characters on the client too, matching the Host.
- Host failures log once with `console.warn` instead of staying invisible.

### Suggestion quality

- The Host strips an echoed draft, including an exact echo (which becomes empty),
  and reuses the same quote/fence cleanup.
- Long answers cut at the last sentence or word boundary instead of a hard
  120-character slice.
- Prompts forbid repeating the draft and cap the answer length.
- Language follows the draft (CJK vs Latin); the UI locale is only a fallback.
- IME composition pauses the idle timer, so pinyin never reaches the model.

### Route

- Requests must come from a loopback `Host` (anti DNS-rebinding), carry
  `Sec-Fetch-Site: same-origin` when the browser sends it, and match `Origin`
  when present. Cross-site pages and non-loopback clients are refused *(behaviour)*.
  Local non-browser clients that send neither header are still accepted by design.

### Engineering

- `test/host.test.mjs` (16 checks) and `test/client.test.mjs` (18 checks) cover
  admission, redaction, boundary cutting, insertion semantics, caching and slot
  registration; `npm test` runs both and CI runs them on every push.
- `engines.dsh` and the README/README.zh now agree on `>=0.2.1-rc.1`.
- `CHANGELOG.md` and a test script ship in the package; `files` updated.

## 1.1.0

- First published bundle: inline ghost completion at the caret, empty-draft
  recommendation pill, Tab to accept, Esc to dismiss, model-backed suggestions
  from the Session transcript with an offline phrase bank as fallback.
