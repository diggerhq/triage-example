/**
 * The things an operator changes, in one place.
 *
 * None of these are secrets, so none of them are managed: the repository under
 * test and the label being swept are facts about the deployment, and a reviewer
 * reading this file learns everything the agent will touch.
 *
 * Note what is NOT here: the mailboxes. They are connected and disconnected by
 * an operator long after this artifact is built, so the agent asks the platform
 * which ones exist at run time. A list in this file would mean a redeploy to
 * add an inbox.
 */

/**
 * The source the agent clones and reads to check a claim against — the project
 * the reports are about. Set this before deploying.
 *
 * It is cloned with a bare `git clone`, so a private repository will fail to
 * check out and every verdict becomes "I could not find the code this
 * describes". Public repositories only, for now.
 */
export const TARGET_REPO = "https://github.com/OWNER/REPO";

/** Reports are whatever the mailbox owner's own filters put this label on. */
export const GMAIL_LABEL = "triage";

/** Verified sender for the findings mail. Resend rejects anything else. */
export const RESEND_FROM = "onboarding@resend.dev";

/** Where the clone lands. Everything the source tools touch is under here. */
export const WORKSPACE = "/tmp/target";
