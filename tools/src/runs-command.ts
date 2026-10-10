/**
 * `lsc runs` — read the run log and report what verification caught.
 *
 * A catch is a failure that a later run fixed. Each run gives each Dafny
 * member a verdict; a streak of failures ending in a pass is one catch, a
 * streak ending with the member gone is dropped, and a streak still failing
 * at the end of the log is open.
 */

import { DAFNY_HELPER_NAMES } from "./dafny-emit.js";
import type { VerifyRecord } from "./run-log.js";

/** What one run says about one member. */
export type Verdict = "fail" | "pass" | "unchecked" | "gone";

/**
 * What a fix changed between the first failing run and the passing run: the
 * TypeScript source, only the Dafny proof, or nothing at all.
 */
export type CatchKind = "source-fix" | "proof" | "flaky";

/** The suffix lsc gives the lemma that carries a function's `//@ ensures`. */
const ENSURES_SUFFIX = "_ensures";

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
  return member.endsWith(ENSURES_SUFFIX) ? member.slice(0, -ENSURES_SUFFIX.length) : member;
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
