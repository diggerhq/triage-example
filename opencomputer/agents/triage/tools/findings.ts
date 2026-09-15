import { defineConnection, defineTool, bearer, useSecret } from "@opencomputer/agent";

import { RESEND_FROM } from "../config.js";
import { mailboxOwner, reportSubject } from "./mailbox.js";

/**
 * Delivering the verdict.
 *
 * The connection is the whole statement of where this can reach: one origin,
 * one method, one path prefix. The API key is a managed secret the egress proxy
 * attaches after checking all three, so it is never in the runtime — and the
 * runtime is forbidden from setting `Authorization` itself, which is what stops
 * an agent from borrowing the connection for somewhere else.
 */
export const resend = defineConnection({
  id: "resend",
  origin: "https://api.resend.com",
  methods: ["POST"],
  pathPrefix: "/emails",
  headers: { Authorization: bearer(useSecret("RESEND_API_KEY")) },
});

type Verdict = {
  classification: string;
  severity: string;
  confidence: string;
  evidence: string;
  analysis: string;
  draft_reply: string;
};

function body(subject: string, verdict: Verdict): string {
  return [
    `Classification: ${verdict.classification}`,
    `Severity: ${verdict.severity}    Confidence: ${verdict.confidence}`,
    `Evidence: ${verdict.evidence}`,
    ``,
    `Analysis:`,
    verdict.analysis,
    ``,
    `Suggested reply:`,
    verdict.draft_reply,
    ``,
    `— triaged automatically for "${subject}". Nothing has been sent to the reporter.`,
  ].join("\n");
}

const enumerated = (description: string, values: string[]) => ({
  type: "string" as const,
  enum: values,
  description,
});

export const sendFindings = defineTool({
  name: "send_findings",
  description:
    "Send your verdict to the maintainer. This is how a triage finishes — the " +
    "findings are not recorded anywhere until you call it. It goes to the " +
    "maintainer for review and is never sent to the reporter.",
  input: {
    type: "object",
    properties: {
      label: {
        type: "string",
        description: "The mailbox the report came from, so it goes to its owner.",
      },
      id: {
        type: "string",
        description: "The report's id, as next_report returned it.",
      },
      classification: enumerated("What the report turned out to be.", [
        "valid",
        "duplicate",
        "bogus",
        "needs-info",
      ]),
      severity: enumerated("Severity if valid; none otherwise.", [
        "none",
        "low",
        "medium",
        "high",
        "critical",
      ]),
      confidence: enumerated("How sure you are, given what you read.", [
        "low",
        "medium",
        "high",
      ]),
      evidence: {
        type: "string",
        description: "file:line references from the checkout supporting the verdict.",
      },
      analysis: { type: "string", description: "Your reasoning." },
      draft_reply: {
        type: "string",
        description: "A reply the maintainer could send to the reporter.",
      },
    },
    required: [
      "label",
      "id",
      "classification",
      "severity",
      "confidence",
      "evidence",
      "analysis",
      "draft_reply",
    ],
    additionalProperties: false,
  },
  async run({ input, signal }) {
    const verdict = input as unknown as Verdict;
    const label = String(input.label ?? "");
    // Read from the message, not taken as an argument, for the same reason as
    // the recipient: a subject handed to the model a dozen tool calls earlier
    // is a fact it would have to restate accurately, and it does not need to.
    const subject = await reportSubject(label, String(input.id ?? ""), signal);

    // The recipient is read from the connected account, not taken as an
    // argument. Everything else on this call was written by a model that has
    // just spent a turn reading a document from a stranger; the address it
    // goes to is the one thing that must not be downstream of that. The model
    // names the MAILBOX, not the recipient — the address comes from the
    // platform's record of who connected it.
    const to = await mailboxOwner(label, signal);

    const response = await resend.fetch("/emails", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        from: RESEND_FROM,
        to,
        subject: `Triage: ${subject} [${verdict.classification}/${verdict.severity}]`,
        text: body(subject, verdict),
      }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      throw new Error(
        `resend: ${response.status} ${(await response.text()).slice(0, 300)}`,
      );
    }
    const { id } = (await response.json()) as { id: string };
    return { sent: true, to, id };
  },
});
