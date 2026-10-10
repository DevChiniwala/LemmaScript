/**
 * `lsc runs` — read the run log and report what verification caught.
 *
 * A catch is a failure that a later run fixed. Each run gives each Dafny
 * member a verdict; a streak of failures ending in a pass is one catch, a
 * streak ending with the member gone is dropped, and a streak still failing
 * at the end of the log is open. Members are then merged per TypeScript
 * function (lsc's generated helpers left out), and each catch is classified
 * by what changed between its first failing run and its passing run. A
 * source fix also gets the diff of its two `.ts` snapshots and a hint at
 * whether the code, the spec or only the proof changed.
 */

import { execFileSync } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { DAFNY_HELPER_NAMES, ENSURES_LEMMA_SUFFIX } from "./dafny-emit.js";
import type { AnnotKind } from "./extract.js";
import type { VerifyRecord } from "./run-log.js";

/**
 * Whether each `//@` keyword the extractor parses states what a function
 * promises (spec) or only helps the proof along. Typed by the extractor's own
 * keyword list, so adding or removing a keyword there fails the typecheck
 * here until it is classified. Other `//@` lines (`assert`, `havoc`, …) count as proof.
 */
const ANNOTATION_ROLES: Record<AnnotKind, "spec" | "proof"> = {
  requires: "spec",
  ensures: "spec",
  contract: "spec",
  invariant: "proof",
  decreases: "proof",
  done_with: "proof",
  type: "proof",
};

/**
 * The shape of the hashes the run log writes. Hashes come from runs.jsonl,
 * which anyone can edit, so only this shape may become a path or a git argument.
 */
const SNAPSHOT_HASH = /^[0-9a-f]{12}$/;

/** What one run says about one member. */
export type Verdict = "fail" | "pass" | "unchecked" | "gone";

/**
 * What a fix changed between the first failing run and the passing run: the
 * TypeScript source, only the Dafny proof, or nothing at all.
 */
export type CatchKind = "source-fix" | "proof" | "flaky";

/**
 * A guess at what a source fix changed, from its `.ts` diff: the code (likely
 * an implementation bug), the spec (likely a spec bug), both, or only proof
 * scaffolding and comments (likely not a bug).
 */
export type ChangeHint = "code" | "spec" | "mixed" | "proof";

/** A member's failure streak, before members are grouped by TypeScript function. */
export interface MemberResult {
  file: string;
  member: string;
  status: "caught" | "open" | "dropped";
  /** The first failing run of the streak. */
  failedRun: VerifyRecord;
  /** The run that passed, for a catch. */
  fixedRun?: VerifyRecord;
  /** The complete run that no longer had the member, for a dropped failure. */
  droppedRun?: VerifyRecord;
}

/** Member results merged per TypeScript function; `failedRun` is the earliest member's. */
export interface FunctionResult {
  file: string;
  function: string;
  members: string[];
  status: MemberResult["status"];
  failedRun: VerifyRecord;
  fixedRun?: VerifyRecord;
  droppedRun?: VerifyRecord;
}

/**
 * A member missing from a partial run (filtered, or one Dafny never reached)
 * was not checked; missing from a complete run, it is gone.
 */
function verdict(run: VerifyRecord, member: string): Verdict {
  if (run.failed.includes(member)) return "fail";
  if (run.passed.includes(member)) return "pass";
  return run.partial ? "unchecked" : "gone";
}

/** Every member's failure streaks, file by file, in log order. */
export function memberResults(records: VerifyRecord[]): MemberResult[] {
  const byFile = new Map<string, VerifyRecord[]>();
  for (const r of records) byFile.set(r.file, [...(byFile.get(r.file) ?? []), r]);

  const results: MemberResult[] = [];
  for (const [file, runs] of byFile) {
    const members = new Set(runs.flatMap(r => [...r.failed, ...r.passed]));
    for (const member of members) {
      let failedRun: VerifyRecord | null = null;
      for (const run of runs) {
        const v = verdict(run, member);
        if (v === "fail") { failedRun ??= run; continue; }
        if (failedRun === null || v === "unchecked") continue;
        results.push(v === "pass"
          ? { file, member, status: "caught", failedRun, fixedRun: run }
          : { file, member, status: "dropped", failedRun, droppedRun: run });
        failedRun = null;
      }
      if (failedRun !== null) results.push({ file, member, status: "open", failedRun });
    }
  }
  return results;
}

/**
 * The TypeScript function a Dafny member verifies: `foo_ensures` belongs to
 * `foo`, and any other member is its own function. Null for lsc's generated
 * helpers, which are not the user's code.
 */
export function functionOf(member: string): string | null {
  if (DAFNY_HELPER_NAMES.has(member)) return null;
  return member.endsWith(ENSURES_LEMMA_SUFFIX) ? member.slice(0, -ENSURES_LEMMA_SUFFIX.length) : member;
}

/**
 * Merge member results into one per TypeScript function: members fixed (or
 * dropped) by the same run are one result, starting at the earliest failure.
 * Generated helpers are left out.
 */
export function groupByFunction(results: MemberResult[]): FunctionResult[] {
  const groups = new Map<string, FunctionResult>();
  for (const r of results) {
    const fn = functionOf(r.member);
    if (fn === null) continue;
    const key = [r.file, fn, r.status, (r.fixedRun ?? r.droppedRun)?.id ?? ""].join("\0");
    const group = groups.get(key);
    if (group === undefined) {
      const { member, ...rest } = r;
      groups.set(key, { ...rest, function: fn, members: [member] });
      continue;
    }
    group.members.push(r.member);
    if (r.failedRun.ts < group.failedRun.ts) group.failedRun = r.failedRun;
  }
  for (const group of groups.values()) group.members.sort();
  return [...groups.values()];
}

/** Compare the first failing run with the passing run: source first, then proof. */
export function classify(failed: VerifyRecord, fixed: VerifyRecord): CatchKind {
  if (failed.tsHash !== fixed.tsHash) return "source-fix";
  if (failed.dfyHash !== fixed.dfyHash) return "proof";
  return "flaky";
}

/** What one changed line of a `.ts` diff touches, or null for blanks and comments. */
function lineChange(text: string): "code" | "spec" | "proof" | null {
  const line = text.trim();
  if (line.startsWith("//@")) return ANNOTATION_ROLES[line.slice(3).trim().split(/\s/)[0] as AnnotKind] === "spec" ? "spec" : "proof";
  if (line === "" || line.startsWith("//") || line.startsWith("/*") || line.startsWith("*")) return null;
  return "code";
}

/** Hint at what a source fix changed, from the `+`/`-` lines of its unified diff. */
export function changeHint(diff: string): ChangeHint {
  const changed = new Set<string>();
  // Only file headers are metadata. Inside a hunk, even a line beginning
  // with "---" is a deletion (for example, `--count;`).
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) inHunk = false;
    else if (line.startsWith("@@ ")) inHunk = true;
    else if (inHunk && (line.startsWith("+") || line.startsWith("-"))) {
      const change = lineChange(line.slice(1));
      if (change !== null) changed.add(change);
    }
  }
  if (changed.has("code")) return changed.has("spec") ? "mixed" : "code";
  return changed.has("spec") ? "spec" : "proof";
}

/**
 * The unified diff between two `.ts` snapshots in `<logDir>/.lemmascript/blobs/`,
 * or null when either is missing, a hash isn't a snapshot hash, or git can't
 * compare them.
 */
export function snapshotDiff(logDir: string, fromHash: string | null, toHash: string | null): string | null {
  if (fromHash === null || toHash === null || !SNAPSHOT_HASH.test(fromHash) || !SNAPSHOT_HASH.test(toHash)) return null;
  const blobs = path.join(logDir, ".lemmascript", "blobs");
  const from = `${fromHash}.ts`;
  const to = `${toHash}.ts`;
  if (!existsSync(path.join(blobs, from)) || !existsSync(path.join(blobs, to))) return null;
  try {
    // Run inside blobs/ so the diff headers name the snapshots, not the machine's paths.
    return execFileSync(
      "git",
      ["diff", "--no-index", "--no-color", "--no-ext-diff", "--no-textconv", "--text", "--", from, to],
      { cwd: blobs, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (e: any) {
    // `git diff --no-index` exits 1 when the files differ; anything else is a failed comparison.
    const stdout = typeof e?.stdout === "string" ? e.stdout : "";
    return e?.status === 1 && e?.signal == null && stdout.startsWith("diff --git ") ? stdout : null;
  }
}
