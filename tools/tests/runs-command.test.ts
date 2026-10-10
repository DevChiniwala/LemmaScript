import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitDafnyFile } from "../src/dafny-emit.ts";
import type { Module } from "../src/ir.ts";
import type { VerifyRecord } from "../src/run-log.ts";
import {
  changeHint, classify, functionOf, groupByFunction, memberResults, snapshotDiff, type FunctionResult, type MemberResult,
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

/** A project directory with an empty `.lemmascript/blobs/`, removed after `run`. */
function withLogDir(run: (logDir: string, blobs: string) => void): void {
  const logDir = realpathSync(mkdtempSync(join(tmpdir(), "lsc-runs-test-")));
  try {
    const blobs = join(logDir, ".lemmascript", "blobs");
    mkdirSync(blobs, { recursive: true });
    run(logDir, blobs);
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
}

/** A one-hunk unified diff of `x.ts` with the given `+`, `-` and context lines. */
function diffOf(...lines: string[]): string {
  return ["diff --git a/x.ts b/x.ts", "--- a/x.ts", "+++ b/x.ts", "@@ -1,9 +1,9 @@", ...lines, ""].join("\n");
}

// The first agent trial's fix (failing snapshot → passing snapshot): the code
// changed, and the loop invariants describing it changed with it.
const AGENT_TRIAL_DIFF = String.raw`diff --git a/6604d7614b7d.ts b/410875aff690.ts
index 179f419..009d3d2 100644
--- a/6604d7614b7d.ts
+++ b/410875aff690.ts
@@ -19,13 +19,14 @@ export function splitBill(totalCents: number, people: number): number[] {
   //@ ensures sumCents(\result) === totalCents
   //@ ensures forall(i, forall(j, 0 <= i && i < \result.length && 0 <= j && j < \result.length ==> \result[i] - \result[j] <= 1))
   const share = Math.floor(totalCents / people);
+  const remainder = totalCents - share * people;
   const shares: number[] = [];
   for (let i = 0; i < people; i++) {
     //@ invariant 0 <= i && i <= people
     //@ invariant shares.length === i
-    //@ invariant forall(k, 0 <= k && k < shares.length ==> shares[k] === share)
-    //@ invariant sumCents(shares) === share * i
-    shares.push(share);
+    //@ invariant forall(k, 0 <= k && k < shares.length ==> shares[k] === share || shares[k] === share + 1)
+    //@ invariant sumCents(shares) === share * i + (i < remainder ? i : remainder)
+    shares.push(i < remainder ? share + 1 : share);
   }
   return shares;
 }
`;

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

test("functionOf maps the ensures lemma the Dafny emitter generates back to its function", () => {
  const double: Module = { comment: "", imports: [], options: [], decls: [{
    kind: "def", name: "double", typeParams: [], params: [{ name: "n", type: { kind: "int" } }], returnType: { kind: "int" },
    requires: [], ensures: [{ kind: "bool", value: true }], decreases: null,
    body: { kind: "binop", op: "+", left: { kind: "var", name: "n" }, right: { kind: "var", name: "n" } },
  }] };
  const lemmas = [...emitDafnyFile(double, "double.ts").matchAll(/^lemma (\w+)/gm)].map(m => m[1]);
  assert.deepEqual(lemmas.map(functionOf), ["double"]);
});

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

// Evidence for source fixes: the diff between the two .ts snapshots, and a hint at what the fix changed.

test("snapshotDiff gives the unified diff from the failing snapshot to the passing one", () =>
  withLogDir((logDir, blobs) => {
    writeFileSync(join(blobs, "aaaaaaaaaaaa.ts"), "const a = 1;\n");
    writeFileSync(join(blobs, "cccccccccccc.ts"), "const a = 2;\n");
    const diff = snapshotDiff(logDir, "aaaaaaaaaaaa", "cccccccccccc");
    assert.match(diff ?? "", /^diff --git a\/aaaaaaaaaaaa\.ts b\/cccccccccccc\.ts\n/);
    assert.match(diff ?? "", /^-const a = 1;$/m);
    assert.match(diff ?? "", /^\+const a = 2;$/m);
  }));

test("snapshotDiff gives null when a snapshot is missing", () =>
  withLogDir((logDir, blobs) => {
    writeFileSync(join(blobs, "aaaaaaaaaaaa.ts"), "const a = 1;\n");
    assert.equal(snapshotDiff(logDir, "aaaaaaaaaaaa", "cccccccccccc"), null);
    assert.equal(snapshotDiff(logDir, null, "aaaaaaaaaaaa"), null);
  }));

// Each bad hash names a file that exists, so only the hash check can keep it out.
for (const hash of ["../x", "-rf", "ABCDEF123456", "aaaaaaaaaaa", "aaaaaaaaaaaaa"]) {
  test(`snapshotDiff refuses the hash ${JSON.stringify(hash)} without reading the file it names`, () =>
    withLogDir((logDir, blobs) => {
      writeFileSync(join(blobs, "aaaaaaaaaaaa.ts"), "const a = 1;\n");
      writeFileSync(join(blobs, `${hash}.ts`), "const a = 2;\n");
      assert.equal(snapshotDiff(logDir, "aaaaaaaaaaaa", hash), null);
      assert.equal(snapshotDiff(logDir, hash, "aaaaaaaaaaaa"), null);
    }));
}

for (const [name, diff, hint] of [
  ["a changed line of code", diffOf("-  return a;", "+  return b;"), "code"],
  ["code with the invariants that describe it (the first agent trial)", AGENT_TRIAL_DIFF, "code"],
  ["a removed decrement, which starts with ---", diffOf("---count;", " return count;"), "code"],
  ["only an ensures", diffOf("-  //@ ensures \\result >= 0", "+  //@ ensures \\result > 0"), "spec"],
  ["only a contract", diffOf("+  //@ contract Returns the larger value"), "spec"],
  ["a requires and code", diffOf("+  //@ requires n > 0", "-  return 0;", "+  return 1;"), "mixed"],
  ["only invariant, decreases and assert lines", diffOf("+    //@ invariant i <= n", "+    //@ decreases n - i", "+    //@ assert i >= 0"), "proof"],
  ["only comments", diffOf("-  // old note", "+  // new note", "+  /* block */", "+   * more"), "proof"],
  ["only blank lines", diffOf("+", "+   "), "proof"],
  ["unchanged context lines, whatever they hold", diffOf("   return a;", "   //@ ensures x", "+  // note"), "proof"],
] as const) {
  test(`changeHint: ${name} → ${hint}`, () => {
    assert.equal(changeHint(diff), hint);
  });
}
