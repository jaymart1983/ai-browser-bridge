# Shipping a module from your agent, and keeping it current

A host application usually owns its own capability module (its tools, its extractors),
and needs that module to track the app's releases. Asking a human to approve every
version bump doesn't add safety — it trains them to click through approvals, which is
worse than the risk it pretends to manage.

So approval is a **standing decision, recorded once**: the first install of a module id
needs a human, and afterwards the agent that shipped it may update *that* module
unattended.

## The endpoint

```
POST /bridge/module/install
Authorization: Bearer <the agent's OAuth access token>
Content-Type: application/json

{ "id": "your-module-id", "code": "export default { id: 'your-module-id', ... }" }
```

Authenticated with the agent's **own** OAuth token — not the unauthenticated web UI —
because the bridge has to know *which* agent is asking in order to record ownership.

**First time** for that id:

```json
{ "ok": true, "needsApproval": true, "reqId": "mi_…" }
```

Nothing is written or executed. A pending approval appears in the extension popup (● on
the toolbar icon) and on the control panel, showing your agent as the requester. When
the user approves, the module is installed **and your agent is recorded as its owner**.

**Every time after that**, from the same agent:

```json
{ "ok": true, "applied": true, "id": "your-module-id", "file": "your-module-id.mjs" }
```

Applied immediately. No prompt. Call it on every launch — if the code is unchanged the
result is simply a reload.

## Declare a version

Put `version` in your manifest. It is what lets a user confirm that what's installed is
what you shipped:

```js
export default { id: 'your-module-id', name: 'Your Module', version: '2.0.35', /* … */ };
```

The bridge shows it on the Modules page and on the module's own page, returns it in the
install response so you can log what actually landed, and records it against the
ownership claim:

```json
{ "ok": true, "applied": true, "id": "ai-analyst", "version": "2.0.35", "file": "ai-analyst.mjs" }
```

A module with no `version` is listed as **"no version declared"** rather than silently
blank — there is nothing to compare, and that should be visible to whoever is looking.

## What ownership is bound to

Deliberately narrow:

- **Your OAuth `client_id`**, not a display name — another agent calling itself
  "AI Analyst" gets nothing.
- **One module id.** An attempt on a module owned by someone else is refused, naming
  the owner.
- **A live grant.** Revoke the agent in the control panel and its ability to update
  ends with it.

The manifest is the authority on what a module *is*, so the bridge verifies the code
actually registers as the id you declared. Declaring an id you own while shipping a
manifest naming a different module is refused **and reverted** — that is the takeover
this design has to prevent, and it is covered by a test.

Deleting a module releases the claim; the next install needs approval again.

## What the user sees

The Modules page marks an owned module:

> Updates automatically from **AI Analyst** — revoke that agent to stop it

and every unattended update is logged:

```
[modules] "ai-analyst" updated by AI Analyst (owner) — no approval needed
```

## Be honest about what this grants

Approving an agent's module means that agent can run its own code inside the bridge,
now and in future versions. That is the point — a module *is* code — but it is worth
stating plainly rather than burying: the approval prompt is the moment that decision is
made, and the Modules page is where it can be withdrawn.
