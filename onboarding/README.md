# Onboarding page

Optional. The agent sweeps whatever mailboxes are connected to the org, and an
admin can connect them directly:

```
POST /api/managed-agents/connections/google/link   { "service": "gmail", "label": "alice" }
```

which returns a consent link to send to that person. This page exists only to
make that self-serve, the way the Worker version it replaces did.

```
wrangler secret put OPENCOMPUTER_API_KEY
wrangler deploy
```

**It is unauthenticated on purpose**, as that version was — anyone with the URL
can attach a mailbox to the sweep. That is fine when the URL is internal and
the consequence is "this person's reports get triaged." It is not fine on a
public URL: connecting a mailbox is free and each one is swept every five
minutes. Put it behind SSO, or don't deploy it and let an admin mint links.
