import { test } from "node:test";
import assert from "node:assert/strict";
import { Project, ScriptTarget } from "ts-morph";
import { extractModule } from "../src/extract.ts";
import { resolveModule } from "../src/resolve.ts";
import { narrowModule } from "../src/narrow.ts";
import { transformModuleDafny } from "../src/transform.ts";
import { emitDafnyFile } from "../src/dafny-emit.ts";

function generate(text: string): string {
  const project = new Project({ compilerOptions: { strict: true,
    target: ScriptTarget.ESNext, lib: ["lib.esnext.d.ts"], types: [], skipLibCheck: true } });
  const source = project.createSourceFile("some.ts", text);
  assert.deepEqual(project.getPreEmitDiagnostics(), [], "input must be valid TypeScript");
  const { typesFile, defFile } = transformModuleDafny(narrowModule(resolveModule(extractModule(source))));
  return emitDafnyFile({ ...defFile, decls: [...(typesFile?.decls ?? []), ...defFile.decls] });
}

test("JavaScript some binds the index rather than a same-named outer variable", () => {
  const capturedIndex = (index: number) => [7].some((value, index) => index === 1);
  assert.equal(capturedIndex(1), false);
  assert.equal(capturedIndex(0), false);
  assert.equal([7].some(value => value === 7), true);
});

for (const [name, text] of [
  ["index shadows an outer parameter", `
    export function capturedIndex(index: number): boolean {
      return [7].some((value, index) => index === 1);
    }`],
  ["index in a block callback", `
    export function capturedIndex(index: number): boolean {
      return [7].some((value, index) => { return index === 1; });
    }`],
  ["index without an outer binding", `
    export function usesIndex(): boolean {
      return [7].some((value, index) => index === 0);
    }`],
  ["array parameter shadows an outer parameter", `
    export function capturedArray(items: number[]): boolean {
      return [7].some((value, index, items) => items.length === 0);
    }`],
] as const) {
  test(`Dafny refuses unsupported some callback parameters: ${name}`, () => {
    assert.throws(() => generate(text), /some.*(index|callback|parameter)/i);
  });
}

test("Dafny still accepts unary and parameterless some callbacks", () => {
  const output = generate(`
    export function unary(xs: number[], limit: number): boolean {
      return xs.some(value => value > limit);
    }
    export function parameterless(xs: number[], x: number): boolean {
      return xs.some(() => x > 0);
    }
    export function named(xs: number[], predicate: (value: number) => boolean): boolean {
      return xs.some(predicate);
    }`);
  assert.match(output, /exists value :: value in xs && \(value > limit\)/);
  const parameterless = output.match(/exists (\S+) :: \1 in xs && \(x > 0\)/);
  assert.ok(parameterless, "parameterless callbacks must preserve the outer x");
  assert.notEqual(parameterless[1], "x");
  assert.match(output, /predicate/);
});
