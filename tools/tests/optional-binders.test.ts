import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Project, ScriptTarget } from "ts-morph";
import { addPaths, addFields, addWithUserName, earlyReturn, addMethod, counterCollision } from "../fixtures/optional-binder-collisions.ts";
import { extractModule } from "../src/extract.ts";
import { resolveModule } from "../src/resolve.ts";
import { narrowModule } from "../src/narrow.ts";
import { transformModuleDafny } from "../src/transform.ts";
import { emitDafnyFile } from "../src/dafny-emit.ts";
import { presentFact, presentMatchExpr } from "../src/condition-facts.ts";
import type { TExpr, TStmt } from "../src/typedir.ts";

function fixture() {
  const project = new Project({ compilerOptions: {
    strict: true, target: ScriptTarget.ESNext, lib: ["lib.esnext.d.ts"], types: [], skipLibCheck: true,
  } });
  const source = project.addSourceFileAtPath(fileURLToPath(new URL("../fixtures/optional-binder-collisions.ts", import.meta.url)));
  assert.deepEqual(project.getPreEmitDiagnostics(), [], "the regression must be valid TypeScript");
  return narrowModule(resolveModule(extractModule(source)));
}

function nestedBindings(body: TStmt[]): [string, string] {
  const outer = body[0];
  assert.equal(outer.kind, "someMatch");
  if (outer.kind !== "someMatch") throw new Error("missing outer match");
  const inner = outer.someBody[0];
  assert.equal(inner.kind, "someMatch");
  if (inner.kind !== "someMatch") throw new Error("missing inner match");
  return [outer.binder, inner.binder];
}

test("distinct optional paths with the same flattened hint have distinct binders", () => {
  assert.equal(addPaths(3, { b: 7 }), 10);
  assert.equal(addFields({ b_c: 2 }, { c: 9 }), 11);
  assert.equal(addWithUserName(3, { b: 7 }, 11), 21);
  assert.equal(addMethod(3, { b: 7 }), 10);
  for (const fn of fixture().functions.filter(f => ["addPaths", "addFields", "addWithUserName", "addMethod"].includes(f.name))) {
    const body = fn.name === "addMethod" ? fn.body.slice(1) : fn.body;
    const [outer, inner] = nestedBindings(body);
    assert.notEqual(outer, inner, fn.name);
    if (fn.name === "addWithUserName") {
      assert.notEqual(outer, "_a_b_val");
      assert.notEqual(inner, "_a_b_val");
    }
  }
});

test("different paths are not deduplicated as the same optional in an early-return chain", () => {
  assert.equal(earlyReturn(3, { b: 7 }), 10);
  assert.equal(earlyReturn(undefined, { b: 7 }), -1);
  assert.equal(earlyReturn(3, {}), -1);
  const fn = fixture().functions.find(f => f.name === "earlyReturn")!;
  const [outer, inner] = nestedBindings(fn.body);
  assert.notEqual(outer, inner);
});

test("path binders cannot capture optional-chain counter binders", () => {
  assert.equal(counterCollision(3, [3]), true);
  assert.equal(counterCollision(3, [7]), false);
  assert.equal(counterCollision(0, [0]), true);
  assert.equal(counterCollision(undefined, [3]), false);
  const fn = fixture().functions.find(f => f.name === "counterCollision")!;
  const outer = fn.body[0];
  assert.equal(outer.kind, "someMatch");
  if (outer.kind !== "someMatch") return;
  const value = outer.someBody[0];
  assert.equal(value.kind, "return");
  if (value.kind !== "return") return;
  const coalesce = value.value;
  assert.equal(coalesce.kind, "someMatch");
  if (coalesce.kind !== "someMatch") return;
  const chain: TExpr = coalesce.scrutinee;
  assert.equal(chain.kind, "someMatch");
  if (chain.kind === "someMatch") assert.notEqual(outer.binder, chain.binder);
});

test("binder allocation is deterministic across repeated compilations", () => {
  const emit = () => {
    const { typesFile, defFile } = transformModuleDafny(fixture());
    return emitDafnyFile({ ...defFile, decls: [...(typesFile?.decls ?? []), ...defFile.decls] });
  };
  assert.equal(emit(), emit());
});

test("path allocation is stable within a pass and isolated between passes", () => {
  const value = (name: string): TExpr => ({ kind: "var", name, ty: { kind: "optional", inner: { kind: "int" } } });
  const fact = (expr: TExpr) => presentFact({ kind: "binop", op: "!==", left: expr,
    right: { kind: "var", name: "undefined", ty: { kind: "void" } }, ty: { kind: "bool" } })!;
  const allocate = (expr: TExpr, ctx: { decls: []; oc: { n: number } }) => {
    const zero: TExpr = { kind: "num", value: 0, ty: { kind: "int" } };
    const match = presentMatchExpr(fact(expr), zero, zero, zero.ty, ctx);
    if (match.kind !== "someMatch") throw new Error("missing match");
    return match.binder;
  };
  const first = { decls: [] as [], oc: { n: 0 } };
  const second = { decls: [] as [], oc: { n: 0 } };
  const source = value("result");
  const returned = value("\\result");
  const outer = allocate(source, first);
  const inner = allocate(returned, first);
  assert.notEqual(outer, inner, "sanitized result paths still have distinct identities");
  assert.equal(allocate(source, first), outer);
  assert.equal(allocate(returned, first), inner);
  assert.equal(allocate(returned, second), outer, "a new pass must not inherit the first pass's occupied names");
});
