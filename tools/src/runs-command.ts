/**
 * `lsc runs` — read the run log and report what verification caught.
 *
 * A catch is a failure that a later run fixed. Each run gives each Dafny
 * member a verdict; a streak of failures ending in a pass is one catch, a
 * streak ending with the member gone is dropped, and a streak still failing
 * at the end of the log is open.
 */

import type { VerifyRecord } from "./run-log.js";

/** What one run says about one member. */
export type Verdict = "fail" | "pass" | "unchecked" | "gone";

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
