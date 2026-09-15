# Triage agent

Reads inbound security reports out of a mailbox, checks each claim against the
actual source, and mails the maintainer a verdict with file:line evidence.

It is a port of an existing production agent onto OpenComputer's serverless
agents — a drop-in replacement, same behaviour, same prompt. That version is a
Cloudflare Worker: a cron sweeps connected mailboxes, each report gets a fresh
sandbox, and a Claude agent inside it POSTs its findings back to a callback.
This is **one agent, eight tools and a cron line**, and the parts of that
sentence that are missing are the point.

Throughout, "the Worker version" means that original.

## What went away

| The Worker version | Here |
|---|---|
| `wrangler.jsonc` cron + `scheduled()` export | `schedules/sweep.ts` |
| Hono app, `/`, `/connect`, `/oauth/callback`, `/report`, `/test` | — |
| Google OAuth: client id, secret, consent screen, code exchange, refresh | `callService({ service: "gmail" })` |
| A KV namespace holding a refresh token per connected user | `listServices()` |
| `Sandbox.create`, poll `isRunning`, `agent.start`, `DELETE /sandboxes/:id` | — |
| `TRIAGE_TOKEN` + `RUN_ID`, `rememberRun`/`takeRun`, the `/report` callback | a tool call |
| `landingPage` / `connectedPage` / `noticePage` | `onboarding/`, optional, ~60 lines |
| 583 lines across ten files | 8 tools, a prompt and a schedule |

Two of those rows are worth more than the others.

### The callback is a tool call

The Worker version has to get an answer out of a sandbox and back into a worker, so it
invents a protocol: mint a run id, put a shared token in the sandbox's
environment, tell the agent in the prompt to `curl` its findings to a callback
URL exactly once with both headers, keep a KV entry mapping the run id to a
recipient, and destroy the sandbox when the POST arrives. Four prompt paragraphs
and three moving parts, all of it transport.

Here the agent calls `send_findings`. The verdict is typed, the call is recorded
in the session, and there is no token, no run id, no callback URL and no sandbox
lifecycle — nothing to leak, expire, or leave running.

### There is no OAuth in this repository

That version owns the Google integration: two secrets, a redirect route, a
consent screen, a KV namespace of refresh tokens, and a client that exchanges
one for an access token before every sweep. `tools/mailbox.ts` replaces all of
it:

```ts
const response = await callService({
  service: "gmail",
  method: "GET",
  path: "/gmail/v1/users/me/messages?q=label:triage+is:unread",
});
```

The platform holds the grant, refreshes it and attaches it on the way out. The
runtime never sees a token — which for an agent whose whole job is reading
documents written by strangers is not a convenience. There is no token in the
process for a successful prompt injection to walk off with.

## The untrusted-input problem

Every triage agent has the same shape: a document written by someone who wants
something from you, and a model with tools. The Worker version's answer is
isolation —
`allowedTools: ["Bash", ...]` with `permissionMode: "bypassPermissions"`, inside
a throwaway sandbox destroyed when the findings land.

This agent keeps the sandbox boundary and narrows what sits inside it. The four
source tools are the operations the task needs, and they do not compose into a
fifth:

- **`clone_source` takes no arguments.** The repository is a constant in
  `config.ts`. No report can redirect the clone somewhere of its choosing.
- **Nothing reaches a shell.** `execFile` takes an argv array, so there is no
  command string to break out of. Searching for `x; touch /tmp/PWNED #` searches
  for that text; it does not run it.
- **Paths stay in the checkout.** `../../../etc/passwd`, `/etc/passwd` and
  `src/../../../../etc/passwd` are all refused before the read.
- **The recipient is not an argument.** `send_findings` resolves it from the
  connected account. Everything else on that call was written by a model that
  just spent a turn reading a stranger's document; the address it goes to is the
  one field that must not be downstream of that.

And the egress manifest is the complete statement of where this can reach,
extracted from the source at build time:

```
egress:  resend https://api.resend.com/emails
```

One origin, one method, one path prefix, with the API key held by the proxy and
attached after all three are checked. The key is never in the runtime, and the
runtime is forbidden from setting `Authorization` itself.

The prompt still warns the model that the report is adversarial — a model that
knows it reads better. But nothing depends on that warning being obeyed.

## Many mailboxes, discovered not configured

The Worker version lets anyone visit `/connect`, stores their refresh token in
KV, and sweeps every row. Mailboxes are data, added without a deploy — that is the
feature, and a port that hard-codes a list in a config file has lost it.

So the agent asks:

```ts
const connected = await listServices({ provider: "google" });
```

That returns every account the org has connected, each with the label to call it
by and the address it belongs to. Connecting a new one is an operator action and
the next run picks it up — no redeploy, no config file, no restart. The platform
also reconciles pending consents before answering, so a mailbox connected thirty
seconds ago is already in the list.

Findings go to that mailbox's own owner, read from `displayName` rather than
offered to the model as an argument. The model names the *mailbox*; the platform
supplies the address.

`onboarding/` is the last piece of that Worker which survives: a page
that turns "triage my inbox" into a Google consent screen, because consent has
to start in a browser and a cron job does not have one. It holds an API key,
mints one connection link per visitor, and redirects. It never sees the consent,
never handles a callback, and never holds a Google credential. It is optional —
an admin can mint links directly.

## One report per mailbox per run

Within a mailbox, the agent takes the oldest untriaged report and stops, rather
than draining the queue. Mailboxes are swept in parallel across the run; reports
within one are not.

That is deliberate and it is the one place the port is not equivalent. The
Worker version dispatches a fresh sandbox per report, so ten are triaged at
once and each gets a clean context. Here a single session sweeps, so two reports
handled in one turn would sit in each other's context — and these are documents
written by people trying to influence the agent that reads them. One per mailbox
per run keeps them apart at the cost of the parallelism.

For a busy mailbox, lower the cron interval. `overlap: "skip"` means a slow run
delays the next rather than racing it.

## What you can see afterwards

A session is a trace. Every run records, in order, at
`GET /v1/sessions/:id/events`:

- `session.created`, `message.received`, `message.completed` — with model cost
- `tool.started` / `tool.completed` / `tool.failed` — every tool call and result,
  including which report was taken and what the searches returned
- `egress.request` / `egress.response` — the Resend call, with status and duration
- `runtime.log`, `session.ended`

The Worker version registers no telemetry at all; its record of a run is
whatever it logged before the sandbox was destroyed.

## Layout

```
opencomputer/
  project.ts
  agents/triage/
    agent.ts                 the prompt, and which tools this agent gets
    config.ts                repo, label, sender — everything non-secret
    schedules/sweep.ts       the cron trigger
    tools/mailbox.ts         Gmail through managed connections, discovered
    tools/source.ts          clone, list, search, read — argv only, path-confined
    tools/findings.ts        the Resend connection and the verdict tool
onboarding/                optional self-serve page (~60 lines)
```

## Running it

1. `npm install`, then `opencomputer login` and
   `opencomputer link --create-project "Triage"`.
2. Connect one or more Google accounts — `onboarding/`, or
   `POST /api/managed-agents/connections/google/link` with a label per person.
   The agent reads one Gmail label and marks messages read; it never sends mail
   as those accounts.

   **Check the scope.** A connection granted `gmail.readonly` can be read and
   searched but not marked read, so the same report is re-triaged every run.
   `mark_triaged` reports this rather than failing the turn, but for unattended
   use the connection needs `gmail.modify`.
3. `opencomputer secrets set RESEND_API_KEY --value-stdin`. Note that Resend's
   shared `onboarding@resend.dev` sender only delivers to the address that owns
   the Resend account — with more than one mailbox connected you need a
   verified domain, and `RESEND_FROM` in `config.ts` changed to match.
4. Set `TARGET_REPO` in `config.ts` to the project the reports are about.
5. In Gmail, filter inbound reports to the `triage` label. The mailbox owner's
   own filters decide what this agent ever sees — changing what gets triaged
   does not mean redeploying it.
6. `npm run deploy`. Development is the default alias, and its schedule runs the
   same five-minute sweep as production. Use `opencomputer deploy --alias production`
   only when you deliberately want to promote the agent.

Findings go to the connected account, for a human to review. Nothing is ever
sent to the reporter.

## What it does not do

- **Reply to reporters.** It drafts; a person sends. An agent that answers a
  bug-bounty submission on its own authority is one confident hallucination away
  from a public argument.
- **Build or run the code it clones.** It reads. A security report is an
  invitation to execute something, and accepting it is the whole attack.
- **Decide what is a report.** That is the mailbox's label, and so the
  maintainer's filters.
