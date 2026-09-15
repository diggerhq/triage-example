import { callService, defineTool, listServices } from "@opencomputer/agent";
import type { ConnectedService, DataValue } from "@opencomputer/agent";

import { GMAIL_LABEL } from "../config.js";

/**
 * Gmail, without the Gmail integration.
 *
 * The original carried a client id, a client secret, an OAuth redirect route,
 * a consent screen, a KV namespace holding one refresh token per connected
 * user, and a token-exchange/refresh client to turn those into an access token
 * before every sweep. None of that is here. The platform holds the grants,
 * refreshes them, and attaches the credential on the way out — so the runtime
 * never sees a token, which for an agent that reads documents written by
 * strangers is not a convenience.
 *
 * The mailboxes are discovered rather than configured. `listServices()` answers
 * with live state, so connecting a new one is an operator action and never a
 * redeploy — which is what the Worker version's self-serve page bought, by
 * writing refresh tokens into KV that the sweep then looped over.
 */

const MAILBOX = "/gmail/v1/users/me";

async function gmail(
  label: string,
  path: string,
  init: { method?: "GET" | "POST"; body?: unknown; signal?: AbortSignal } = {},
): Promise<unknown> {
  const response = await callService({
    service: "gmail",
    label,
    method: init.method ?? "GET",
    path: `${MAILBOX}${path}`,
    ...(init.body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(init.body),
        }),
    ...(init.signal ? { signal: init.signal } : {}),
  });
  // Managed connections hand back the upstream response untouched, so a 403 for
  // a missing scope and a 404 for a deleted message stay distinguishable. Both
  // are worth surfacing verbatim: a scope problem is an operator's to fix, and a
  // model told only "it failed" will retry it forever.
  if (!response.ok) {
    throw new Error(
      `gmail ${label} ${path}: ${response.status} ${(await response.text()).slice(0, 300)}`,
    );
  }
  return response.json();
}

/** Every connected Google account, by the alias it was connected under. */
async function mailboxes(signal?: AbortSignal): Promise<ConnectedService[]> {
  return listServices({ provider: "google", signal });
}

interface MailPart {
  mimeType?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string };
  parts?: MailPart[];
}

const decode = (data: string) => Buffer.from(data, "base64url").toString("utf8");

/** Prefer text/plain anywhere in the tree; fall back to de-tagged HTML. */
function extractText(part: MailPart): string {
  if (part.mimeType === "text/plain" && part.body?.data) return decode(part.body.data);
  if (part.parts) {
    const plain = part.parts.map(extractText).filter(Boolean).join("\n");
    if (plain.trim()) return plain;
  }
  if (part.mimeType === "text/html" && part.body?.data) {
    return decode(part.body.data).replace(/<[^>]+>/g, " ");
  }
  return "";
}

export const listMailboxes = defineTool({
  name: "list_mailboxes",
  description:
    "List the mailboxes this agent sweeps. Call it first: each one is swept " +
    "separately and its findings go back to its own owner. An empty list " +
    "means nobody has connected an account yet and there is nothing to do.",
  input: { type: "object", properties: {}, additionalProperties: false },
  async run({ signal }) {
    const connected = await mailboxes(signal);
    return {
      mailboxes: connected.map((connection) => ({
        label: connection.label,
        // displayName is the account's own address, resolved by the platform.
        // It is what findings are addressed to, so the model never picks it.
        owner: connection.displayName ?? "(unknown)",
      })),
    };
  },
});

export const nextReport = defineTool({
  name: "next_report",
  description:
    "Take the oldest untriaged report from one mailbox. Returns its id, " +
    "subject and body, and how many others are waiting in that mailbox. " +
    "waiting: 0 means this mailbox is clear — move to the next one.",
  input: {
    type: "object",
    properties: {
      label: {
        type: "string",
        description: "The mailbox, as returned by list_mailboxes.",
      },
    },
    required: ["label"],
    additionalProperties: false,
  },
  // Annotated, because the two returns are different shapes and inference
  // widens the union into optional-undefined properties that a tool result
  // cannot hold. An empty queue is `{ label, waiting: 0 }` and nothing else.
  async run({ input, signal }): Promise<{ readonly [key: string]: DataValue }> {
    const label = String(input.label ?? "");
    if (!label) throw new Error("next_report needs a mailbox label");
    const query = encodeURIComponent(`label:${GMAIL_LABEL} is:unread`);
    const list = (await gmail(label, `/messages?q=${query}`, { signal })) as {
      messages?: { id: string }[];
    };
    const waiting = list.messages ?? [];
    if (!waiting.length) return { label, waiting: 0 };

    // Gmail lists newest first and this drains one at a time, so take the last
    // — oldest first, or a busy morning starves everything reported yesterday.
    const id = waiting[waiting.length - 1]!.id;
    const message = (await gmail(label, `/messages/${id}?format=full`, { signal })) as {
      payload: MailPart;
    };
    const subject =
      (message.payload.headers ?? []).find(
        (header) => header.name.toLowerCase() === "subject",
      )?.value ?? "(no subject)";

    return {
      label,
      waiting: waiting.length,
      id,
      subject,
      body: extractText(message.payload),
    };
  },
});

export const markTriaged = defineTool({
  name: "mark_triaged",
  description:
    "Mark a report as triaged so it is not picked up again. Call this only " +
    "after its findings have been sent.",
  input: {
    type: "object",
    properties: {
      label: { type: "string", description: "The mailbox the report came from." },
      id: { type: "string", description: "The report's id." },
    },
    required: ["label", "id"],
    additionalProperties: false,
  },
  // Annotated for the same reason as next_report: the success and read-only
  // returns are different shapes, and the inferred union carries an optional
  // `reason: undefined` that a tool result cannot hold.
  async run({ input, signal }): Promise<{ readonly [key: string]: DataValue }> {
    const label = String(input.label ?? "");
    const id = String(input.id ?? "");
    if (!label || !id) throw new Error("mark_triaged needs a mailbox label and a report id");
    try {
      // Clearing UNREAD is what takes it out of the `is:unread` query. The label
      // stays, so the mailbox keeps its own record of what was triaged.
      await gmail(label, `/messages/${id}/modify`, {
        method: "POST",
        body: { removeLabelIds: ["UNREAD"] },
        signal,
      });
      return { id, triaged: true };
    } catch (error) {
      // A connection granted read-only scope cannot clear UNREAD. That is a
      // property of how the account was connected, not a mistake the model can
      // correct, so say so once and let the turn finish — the findings are
      // already sent, and retrying would only re-send them.
      const message = error instanceof Error ? error.message : String(error);
      return {
        id,
        triaged: false,
        reason: message.includes("403")
          ? "This mailbox is connected read-only, so it cannot be marked read. " +
            "The findings were still sent. Do not retry; continue."
          : message,
      };
    }
  },
});

/**
 * Who a mailbox belongs to.
 *
 * Not a tool. Findings go to the account that received the report, and that
 * address is resolved here rather than offered to the model — that version was
 * careful that the agent never chooses a recipient, and an agent that has just
 * read an adversarial document is exactly the wrong thing to let address mail.
 */
/** A report's subject line, read from the message rather than restated. */
export async function reportSubject(
  label: string,
  id: string,
  signal?: AbortSignal,
): Promise<string> {
  const message = (await gmail(
    label,
    `/messages/${id}?format=metadata&metadataHeaders=Subject`,
    { signal },
  )) as { payload?: MailPart };
  return (
    (message.payload?.headers ?? []).find(
      (header) => header.name.toLowerCase() === "subject",
    )?.value ?? "(no subject)"
  );
}

export async function mailboxOwner(
  label: string,
  signal?: AbortSignal,
): Promise<string> {
  const connection = (await mailboxes(signal)).find(
    (candidate) => candidate.label === label,
  );
  if (connection?.displayName) return connection.displayName;
  // Fall back to the account's own profile: displayName is resolved lazily by
  // the platform and can be absent on a freshly connected mailbox.
  const profile = (await gmail(label, "/profile", { signal })) as {
    emailAddress?: string;
  };
  if (!profile.emailAddress) throw new Error(`no address for mailbox ${label}`);
  return profile.emailAddress;
}
