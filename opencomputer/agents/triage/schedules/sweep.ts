import { defineSchedule } from "@opencomputer/agent";

/**
 * The cron trigger, and the only thing that starts this agent.
 *
 * It replaces a `triggers.crons` entry in wrangler.jsonc and a `scheduled()`
 * export — same five fields, but the handler it wakes is the agent rather than
 * a worker that then has to go and find one.
 *
 * `overlap: "skip"` is doing real work. A triage run clones a repository and
 * reads it, so a slow one can outlast five minutes; without this the next tick
 * would start a second run, and two runs would take the same report.
 *
 * One report per mailbox per run, deliberately — see the prompt. Lower the
 * interval for a busier mailbox; a run takes a couple of minutes, so
 * minute-by-minute mostly means `skip` doing its job rather than five times
 * the throughput.
 *
 * Production only. A development deployment is for driving by hand with
 * `opencomputer run triage`, and a cron firing behind that would re-read the
 * same mailbox while you are looking at it.
 */
export default defineSchedule({
  id: "sweep",
  cron: "*/5 * * * *",
  timezone: "UTC",
  enabled: ["production"],
  overlap: "skip",
  dispatch: {
    text: "Check the mailbox and triage the next report, if there is one.",
  },
});
