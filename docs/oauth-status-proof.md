# Proving you initiated an authorization before `/oauth/status` returns the code

## The problem

`/oauth/status?reqId=…` returns the approved redirect — which carries `?code=…` — and
`/bridge/status` publishes every pending request's `reqId`. Both are loopback and
unauthenticated, so **any local process can read an authorization code the user just
approved for a different agent.**

PKCE means a thief cannot exchange that code for tokens. The one directly exploitable
consequence — spending the code with a bogus verifier to destroy the real client's
exchange, which forced it to re-authorize forever — was fixed in v0.1.34 (a failed
exchange no longer consumes the code).

What remains is a credential-bearing value readable by any local process. Not
exploitable today; worth closing because it is exactly the kind of thing that becomes
exploitable after some later, unrelated change.

## The rule

`/oauth/status` always reports state. It returns the **code** only to a caller that
proves it initiated the request, by presenting one of:

| Proof | Who has it |
|---|---|
| `cc=<code_challenge>` | the client that called `/oauth/authorize` — it is never published (`listPending()` deliberately omits it) |
| `ps=<pageSecret>` | the consent page the bridge itself rendered, per request |

Compared in constant time. Without proof the caller gets `{pending}` / `{denied}` /
`{approved:true}` — state, never the code.

```
GET /oauth/status?reqId=<id>&cc=<code_challenge>   → { "redirect": "…?code=…&state=…" }
GET /oauth/status?reqId=<id>                       → { "approved": true }
```

## Rollout

`ENFORCE_STATUS_PROOF` in `bridge/oauth.mjs` gates this, so no client breaks on a
bridge upgrade:

- **`false` (current)** — an unproven caller still receives the code, and is named once
  per request in the log:

  ```
  [oauth] status: "<client>" read a code without proof — it should poll with
  &cc=<code_challenge>. See docs/oauth-status-proof. (allowed for now)
  ```

  That line is the migration signal. It disappears when every polling client has been
  updated.

- **`true`** — unproven callers get state only.

Flip it once the log is quiet. Verified both modes: with proof the code is returned in
either mode; without proof it is returned-and-warned under `false`, and withheld under
`true`.

## For client authors

If you poll this endpoint (rather than receiving the code on your `redirect_uri`), send
the same `code_challenge` you sent to `/oauth/authorize`:

```
/oauth/status?reqId=<id>&cc=<code_challenge>
```

You already have it — it is the SHA-256 of your PKCE verifier. Nothing else changes.
Clients that receive the code the ordinary way, by redirect to their own callback, are
unaffected.
