import { test } from "node:test";
import assert from "node:assert/strict";
import type { VerifyRecord } from "../src/run-log.ts";
import {
  classify, functionOf, groupByFunction, memberResults, type FunctionResult, type MemberResult,
} from "../src/runs-command.ts";

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

/** One line per member result (from memberResults): file, member, status and the runs it spans. */
function memberSummary(results: MemberResult[]): string[] {
  return results.map(r => {
    const end = r.fixedRun ?? r.droppedRun;
    return `${r.file} ${r.member} ${r.status} ${r.failedRun.id}${end ? `→${end.id}` : ""}`;
  });
}

/** One line per function result (from groupByFunction): file, function, status, members and the runs it spans. */
function functionSummary(results: FunctionResult[]): string[] {
  return results.map(r => {
    const end = r.fixedRun ?? r.droppedRun;
    return `${r.file} ${r.function} ${r.status} [${r.members.join(",")}] ${r.failedRun.id}${end ? `→${end.id}` : ""}`;
  });
}

// Member results: each Dafny member's failure streaks, marked caught, open or dropped.

test("a failure followed by a pass is one catch", () => {
  assert.deepEqual(memberSummary(memberResults(log({ failed: ["f"] }, { passed: ["f"] }))), ["a.ts f caught r1→r2"]);
});

test("a streak of failures ending in a pass is one catch starting at the first failure", () => {
  const records = log({ failed: ["f"] }, { failed: ["f"] }, { failed: ["f"] }, { passed: ["f"] });
  assert.deepEqual(memberSummary(memberResults(records)), ["a.ts f caught r1→r4"]);
});

test("a partial run that does not mention the member is skipped", () => {
  const records = log({ failed: ["f"] }, { partial: true, passed: ["g"] }, { passed: ["f"] });
  assert.deepEqual(memberSummary(memberResults(records)), ["a.ts f caught r1→r3"]);
});

test("a complete run without a failing member drops the failure", () => {
  const records = log({ failed: ["f"] }, { passed: ["g"] });
  assert.deepEqual(memberSummary(memberResults(records)), ["a.ts f dropped r1→r2"]);
});

test("a partial run without a failing member never drops it", () => {
  const records = log({ failed: ["f"] }, { partial: true, stage: "diff", exit: 1 }, { partial: true, passed: ["g"] });
  assert.deepEqual(memberSummary(memberResults(records)), ["a.ts f open r1"]);
});

test("a failure with no later pass is open", () => {
  assert.deepEqual(memberSummary(memberResults(log({ passed: ["f"] }, { failed: ["f"] }))), ["a.ts f open r2"]);
});

test("two separate fail-then-pass streaks are two catches", () => {
  const records = log({ failed: ["f"] }, { passed: ["f"] }, { failed: ["f"] }, { passed: ["f"] });
  assert.deepEqual(memberSummary(memberResults(records)), ["a.ts f caught r1→r2", "a.ts f caught r3→r4"]);
});

test("files are independent: a run of one file never passes or drops another file's member", () => {
  const records = log({ file: "a.ts", failed: ["f"] }, { file: "b.ts", passed: ["f"] }, { file: "a.ts", passed: ["f"] });
  assert.deepEqual(memberSummary(memberResults(records)), ["a.ts f caught r1→r3"]);
});

test("repeated passes add nothing", () => {
  const records = log({ passed: ["f"] }, { failed: ["f"] }, { passed: ["f"] }, { passed: ["f"] }, { passed: ["f"] });
  assert.deepEqual(memberSummary(memberResults(records)), ["a.ts f caught r2→r3"]);
});

test("a member that failed in a filtered run still counts as failed", () => {
  const records = log({ partial: true, failed: ["f"] }, { passed: ["f"] });
  assert.deepEqual(memberSummary(memberResults(records)), ["a.ts f caught r1→r2"]);
});

// Grouping by TypeScript function: a function's Dafny members (foo, foo_ensures) count as one catch; lsc's generated helpers don't count.

for (const [member, fn] of [
  ["splitBill", "splitBill"],
  ["splitBill_ensures", "splitBill"],
  ["Counter.inc_ensures", "Counter.inc"],
  ["JSFloorDiv", null],
  ["SetToSeq", null],
  ["sumIsMonotone", "sumIsMonotone"],
] as const) {
  test(`functionOf maps ${member} to ${fn ?? "nothing (a generated helper)"}`, () => {
    assert.equal(functionOf(member), fn);
  });
}

test("a function and its ensures lemma fixed by the same run are one catch from the earliest failure", () => {
  const records = log({ failed: ["foo_ensures"], passed: ["foo"] }, { failed: ["foo", "foo_ensures"] }, { passed: ["foo", "foo_ensures"] });
  assert.deepEqual(functionSummary(groupByFunction(memberResults(records))), ["a.ts foo caught [foo,foo_ensures] r1→r3"]);
});

test("members of one function fixed by different runs are separate catches", () => {
  const records = log({ failed: ["foo"], passed: ["foo_ensures"] }, { failed: ["foo_ensures"], passed: ["foo"] }, { passed: ["foo", "foo_ensures"] });
  assert.deepEqual(functionSummary(groupByFunction(memberResults(records))), [
    "a.ts foo caught [foo] r1→r2",
    "a.ts foo caught [foo_ensures] r2→r3",
  ]);
});

test("generated helpers are left out of catches", () => {
  const records = log({ failed: ["JSFloorDiv", "f"] }, { passed: ["JSFloorDiv", "f"] });
  assert.deepEqual(functionSummary(groupByFunction(memberResults(records))), ["a.ts f caught [f] r1→r2"]);
});

test("open and dropped failures are grouped by file and function", () => {
  const records = log(
    { file: "a.ts", failed: ["g", "g_ensures"] },
    { file: "b.ts", failed: ["h"], passed: ["h_ensures"] }, { file: "b.ts", failed: ["h", "h_ensures"] }, { file: "b.ts", passed: ["x"] },
  );
  assert.deepEqual(functionSummary(groupByFunction(memberResults(records))), [
    "a.ts g open [g,g_ensures] r1",
    "b.ts h dropped [h,h_ensures] r2→r4",
  ]);
});

// Kinds of catch: what changed between the first failing run and the passing run (.ts, only .dfy, or nothing).

for (const [name, failed, fixed, kind] of [
  ["a changed .ts is a source fix", { tsHash: "aaaaaaaaaaaa" }, { tsHash: "cccccccccccc", dfyHash: "dddddddddddd" }, "source-fix"],
  ["a changed .dfy alone is a proof fix", {}, { dfyHash: "dddddddddddd" }, "proof"],
  ["no change is flaky", {}, {}, "flaky"],
] as const) {
  test(`classify: ${name}`, () => {
    const [a, b] = log(failed, fixed);
    assert.equal(classify(a, b), kind);
  });
}

test("classify compares the first failing run, not the last, with the passing run", () => {
  const records = log({ failed: ["f"], tsHash: "aaaaaaaaaaaa" }, { failed: ["f"], tsHash: "cccccccccccc" }, { passed: ["f"], tsHash: "cccccccccccc" });
  const [caught] = memberResults(records);
  assert.equal(classify(caught.failedRun, caught.fixedRun!), "source-fix");
});
