import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_OPTIONS, resolveOptions } from "../src/config.ts";
import { DAFNY_HELPER_NAMES, emitDafnyFile } from "../src/dafny-emit.ts";
import type { Decl, Expr, Module } from "../src/ir.ts";

const utf16 = resolveOptions({ "string-semantics": "javascript-utf16", "dafny-library": "local" }, "test");
const optionsHeader = /^\/\/ lsc options: string-semantics=javascript-utf16$/m;

function moduleWith(...decls: Decl[]): Module {
  return { comment: "", imports: [], options: [], decls };
}

const numbers = moduleWith({ kind: "const", name: "answer", type: { kind: "int" }, value: { kind: "num", value: 42 } });
const stringType: Decl = { kind: "type-alias", name: "Text", target: { kind: "string" } };

test("programmatic emission rejects UTF-16 with the default standard library", () => {
  assert.throws(() => emitDafnyFile(numbers, "numbers.ts", { ...DEFAULT_OPTIONS, "string-semantics": "javascript-utf16" }),
    /numbers\.ts:.*javascript-utf16.*dafny-library.*stdlib.*local/);
});

for (const [method, helper, resultType] of [
  ["filter", "Filter", { kind: "array", elem: { kind: "int" } }],
  ["every", "All", { kind: "bool" }],
  ["reduce", "FoldLeft", { kind: "int" }],
] as const) {
  test(`${method} follows the library option independently of string semantics`, () => {
    const callback: Expr = { kind: "var", name: "callback" };
    const file = moduleWith({ kind: "const", name: "value", type: resultType, value: {
      kind: "methodCall", obj: { kind: "var", name: "values" }, objTy: { kind: "array", elem: { kind: "int" } },
      method, args: method === "reduce" ? [callback, { kind: "num", value: 0 }] : [callback], monadic: false,
    } });
    const standard = emitDafnyFile(file, "collections.ts");
    assert.ok(standard.includes(`Std.Collections.Seq.${helper}(`));
    for (const options of [resolveOptions({ "dafny-library": "local" }, "test"), utf16]) {
      const local = emitDafnyFile(file, "collections.ts", options);
      assert.doesNotMatch(local, /Std\./);
      assert.match(local, new RegExp(`(?:function|predicate) Seq${helper}<`));
    }
    // A local emission must not change the next file's default library.
    assert.equal(emitDafnyFile(file, "collections.ts"), standard);
    assert.equal(emitDafnyFile(file, "collections.ts", resolveOptions({ "dafny-library": "stdlib" }, "test")), standard);
  });
}

test("UTF-16 stamps numeric-only modules so proof additions use the selected model", () => {
  assert.match(emitDafnyFile(numbers, "numbers.ts", utf16), optionsHeader);
  assert.doesNotMatch(emitDafnyFile(numbers, "numbers.ts"), optionsHeader);
  assert.match(emitDafnyFile(numbers, "numbers.ts", utf16), optionsHeader);
});

test("string profile and literal encoding reset between files", () => {
  const literal = moduleWith({ kind: "const", name: "emoji", type: { kind: "string" }, value: { kind: "str", value: "😀" } });
  const encoded = emitDafnyFile(literal, "literal.ts", utf16);
  assert.match(encoded, optionsHeader);
  assert.ok(encoded.includes('"\\uD83D\\uDE00"'));

  // Omit the options argument so the default must replace the previous profile.
  const scalar = emitDafnyFile(literal, "literal.ts");
  assert.doesNotMatch(scalar, optionsHeader);
  assert.ok(scalar.includes('"😀"'));
  assert.equal(emitDafnyFile(literal, "literal.ts", utf16), encoded);
});

test("string helper preambles do not leak into the next file", () => {
  const baseline = emitDafnyFile(numbers, "numbers.ts", utf16);
  const search = moduleWith({ kind: "const", name: "position", type: { kind: "int" }, value: {
    kind: "methodCall", obj: { kind: "str", value: "hello" }, objTy: { kind: "string" },
    method: "indexOf", args: [{ kind: "str", value: "e" }], monadic: false,
  } });
  const output = emitDafnyFile(search, "search.ts", utf16);
  assert.match(output, optionsHeader);
  assert.match(output, /function StringIndexOf\(/);
  assert.equal(emitDafnyFile(numbers, "numbers.ts", utf16), baseline);
});

for (const inNamespace of [false, true]) {
  test(`string profile resets after failed emission${inNamespace ? " inside a namespace" : ""}`, () => {
    const baseline = emitDafnyFile(numbers, "numbers.ts", utf16);
    const declarations: Decl[] = [stringType, {
      kind: "const", name: "unsupported", type: { kind: "int" }, value: {
        kind: "methodCall", obj: { kind: "str", value: "hello" }, objTy: { kind: "string" },
        method: "unsupported", args: [], monadic: false,
      },
    }];
    const failing = inNamespace
      ? moduleWith({ kind: "namespace", name: "Example", decls: declarations })
      : moduleWith(...declarations);
    assert.throws(() => emitDafnyFile(failing, "unsupported.ts", utf16), /Unsupported Dafny method call/);
    assert.equal(emitDafnyFile(numbers, "numbers.ts", utf16), baseline);
  });
}

test("the generated helper names include preamble functions, predicates, lemmas and methods", () => {
  for (const name of [
    "JSFloorDiv", "JSRem", "SeqFilter", "NormalizeSliceIndex", "SafeSlice", "StringTrim", // functions
    "SeqSort",                                                                            // function with {:axiom}
    "IsJSWhitespace",                                                                     // predicate
    "MaxOfSeqConcat",                                                                     // lemma
    "SetToSeq",                                                                           // method
  ]) {
    assert.ok(DAFNY_HELPER_NAMES.has(name), name);
  }
  assert.ok(!DAFNY_HELPER_NAMES.has("splitBill"));
  assert.ok(!DAFNY_HELPER_NAMES.has("Option"));
});

test("the generated helper names ignore declaration keywords inside preamble comments", () => {
  assert.ok(!DAFNY_HELPER_NAMES.has("bodies"));
});
