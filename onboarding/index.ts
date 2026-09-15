/**
 * Self-serve inbox connection — the one piece of the Worker version that does not
 * disappear.
 *
 * Everything else demo-agent-triage's Worker did is gone: no KV, no refresh
 * tokens, no token exchange, no Gmail client, no sweep, no callback. What is
 * left is a page that turns "I want my inbox triaged" into a Google consent
 * screen, because a consent screen has to be started by a browser and an agent
 * on a cron does not have one.
 *
 * It holds an API key and mints a connection link per visitor. The mailbox
 * lands under the org's account with its own label, which is what lets one
 * scheduled agent sweep everybody's — the same shape as that version's KV of
 * per-user refresh tokens, with the tokens kept by the platform instead.
 *
 * Note what it does NOT do: it never sees the consent, never handles a
 * callback, and never holds a Google credential. There is nothing here to leak.
 */

interface Env {
  OC_API_URL: string;
  OPENCOMPUTER_API_KEY: string;
}

// Labels identify a mailbox to the agent and must match the platform's pattern.
// Generated rather than typed: we do not know who the visitor is until after
// they consent, and the platform reports the address back as displayName.
const label = () => `inbox-${crypto.randomUUID().slice(0, 8)}`;

const page = (body: string) => new Response(
  `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
   <title>Connect your inbox</title>
   <style>
     body{font:16px/1.6 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem}
     a.btn{display:inline-block;background:#111;color:#fff;padding:.7rem 1.2rem;border-radius:.4rem;text-decoration:none}
     p{color:#444} code{background:#f4f4f5;padding:.1rem .3rem;border-radius:.2rem}
   </style>${body}`,
  { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/connect") {
      const response = await fetch(
        `${env.OC_API_URL}/api/managed-agents/connections/google/link`,
        {
          method: "POST",
          headers: {
            "x-api-key": env.OPENCOMPUTER_API_KEY,
            "content-type": "application/json",
          },
          body: JSON.stringify({ service: "gmail", label: label() }),
        },
      );
      if (!response.ok) {
        return page(`<h1>Something went wrong</h1><p>The connection could not be
          started (${response.status}). Try again, or ask an admin.</p>`);
      }
      const { authorizationUrl } = (await response.json()) as { authorizationUrl: string };
      return Response.redirect(authorizationUrl, 302);
    }

    return page(`<h1>Connect your inbox</h1>
      <p>Security reports you label <code>triage</code> will be checked against
      the source code, and the findings mailed back to you. Nothing is ever sent
      to the reporter.</p>
      <p><a class=btn href="/connect">Connect Gmail</a></p>`);
  },
};
