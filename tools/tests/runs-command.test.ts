import { test } from "node:test";
import assert from "node:assert/strict";
import type { VerifyRecord } from "../src/run-log.ts";
import { memberResults, type MemberResult } from "../src/runs-command.ts";

/**
 * A run log built in order: each record gets id `r1`, `r2`, … and a timestamp
 * one minute after the last. Unset fields default to a complete check of `a.ts`.
 */
function log(...records: Partial<VerifyRecord>[]): VerifyRecord[] {
  return records.map((r, i) => {
    const failed = r.failed ?? [];
    return {
      v: 1, type: "verify", id: `r${i + 1}`, ts: new Date(Date.UTC(2026, 9, 6, 1, i)).toISOString(),
      cmd: "check", file: "a.ts", stage: failed.length > 0 ? "verify" : "ok", exit: failed.length > 0 ? 4 : 0,
      partial: false, failed, passed: [], tsHash: "aaaaaaaaaaaa", dfyHash: "bbbbbbbbbbbb", lsc: "0",
      ...r,
    };
  });
}

/** One line per result: file, member, status and the runs it spans. */
function summary(results: MemberResult[]): string[] {
  return results.map(r => {
    const end = r.fixedRun ?? r.droppedRun;
    return `${r.file} ${r.member} ${r.status} ${r.failedRun.id}${end ? `→${end.id}` : ""}`;
  });
}

// Member-level results.

test("a failure followed by a pass is one catch", () => {
  assert.deepEqual(summary(memberResults(log({ failed: ["f"] }, { passed: ["f"] }))), ["a.ts f caught r1→r2"]);
});

test("a streak of failures ending in a pass is one catch starting at the first failure", () => {
  const records = log({ failed: ["f"] }, { failed: ["f"] }, { failed: ["f"] }, { passed: ["f"] });
  assert.deepEqual(summary(memberResults(records)), ["a.ts f caught r1→r4"]);
});

test("a partial run that does not mention the member is skipped", () => {
  const records = log({ failed: ["f"] }, { partial: true, passed: ["g"] }, { passed: ["f"] });
  assert.deepEqual(summary(memberResults(records)), ["a.ts f caught r1→r3"]);
});

test("a complete run without a failing member drops the failure", () => {
  const records = log({ failed: ["f"] }, { passed: ["g"] });
  assert.deepEqual(summary(memberResults(records)), ["a.ts f dropped r1→r2"]);
});

test("a partial run without a failing member never drops it", () => {
  const records = log({ failed: ["f"] }, { partial: true, stage: "diff", exit: 1 }, { partial: true, passed: ["g"] });
  assert.deepEqual(summary(memberResults(records)), ["a.ts f open r1"]);
});

test("a failure with no later pass is open", () => {
  assert.deepEqual(summary(memberResults(log({ passed: ["f"] }, { failed: ["f"] }))), ["a.ts f open r2"]);
});

test("two separate fail-then-pass streaks are two catches", () => {
  const records = log({ failed: ["f"] }, { passed: ["f"] }, { failed: ["f"] }, { passed: ["f"] });
  assert.deepEqual(summary(memberResults(records)), ["a.ts f caught r1→r2", "a.ts f caught r3→r4"]);
});

test("files are independent: a run of one file never passes or drops another file's member", () => {
  const records = log({ file: "a.ts", failed: ["f"] }, { file: "b.ts", passed: ["f"] }, { file: "a.ts", passed: ["f"] });
  assert.deepEqual(summary(memberResults(records)), ["a.ts f caught r1→r3"]);
});

test("repeated passes add nothing", () => {
  const records = log({ passed: ["f"] }, { failed: ["f"] }, { passed: ["f"] }, { passed: ["f"] }, { passed: ["f"] });
  assert.deepEqual(summary(memberResults(records)), ["a.ts f caught r2→r3"]);
});

test("a member that failed in a filtered run still counts as failed", () => {
  const records = log({ partial: true, failed: ["f"] }, { passed: ["f"] });
  assert.deepEqual(summary(memberResults(records)), ["a.ts f caught r1→r2"]);
});
