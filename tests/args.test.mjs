import test from "node:test";
import assert from "node:assert/strict";

import { parseArgs, splitRawArgumentString } from "../plugins/codex/scripts/lib/args.mjs";

test("splitRawArgumentString splits on whitespace and collapses runs", () => {
  assert.deepEqual(splitRawArgumentString("a b c"), ["a", "b", "c"]);
  assert.deepEqual(splitRawArgumentString("  a   b  "), ["a", "b"]);
  assert.deepEqual(splitRawArgumentString(""), []);
  assert.deepEqual(splitRawArgumentString("   "), []);
});

test("splitRawArgumentString honors single and double quotes", () => {
  assert.deepEqual(splitRawArgumentString('"hello world" x'), ["hello world", "x"]);
  assert.deepEqual(splitRawArgumentString("'hi there'"), ["hi there"]);
  assert.deepEqual(splitRawArgumentString('foo"bar baz"'), ["foobar baz"]);
  // A quote can hold whitespace that would otherwise split.
  assert.deepEqual(splitRawArgumentString('--prompt "fix the bug" --write'), ["--prompt", "fix the bug", "--write"]);
});

test("splitRawArgumentString handles backslash escapes", () => {
  assert.deepEqual(splitRawArgumentString("a\\ b"), ["a b"]);
  assert.deepEqual(splitRawArgumentString('\\"quoted\\"'), ['"quoted"']);
  // A trailing backslash is preserved literally rather than dropped.
  assert.deepEqual(splitRawArgumentString("abc\\"), ["abc\\"]);
});

test("parseArgs parses boolean flags including inline =false", () => {
  assert.deepEqual(parseArgs(["--json"], { booleanOptions: ["json"] }), { options: { json: true }, positionals: [] });
  assert.deepEqual(parseArgs(["--json=false"], { booleanOptions: ["json"] }).options, { json: false });
  assert.deepEqual(parseArgs(["-x"], { booleanOptions: ["x"] }).options, { x: true });
});

test("parseArgs parses value options inline, spaced, and aliased", () => {
  assert.deepEqual(parseArgs(["--model", "gpt"], { valueOptions: ["model"] }).options, { model: "gpt" });
  assert.deepEqual(parseArgs(["--model=gpt"], { valueOptions: ["model"] }).options, { model: "gpt" });
  assert.deepEqual(
    parseArgs(["-m", "gpt"], { valueOptions: ["model"], aliasMap: { m: "model" } }).options,
    { model: "gpt" }
  );
});

test("parseArgs collects positionals, unknown flags, and honors --", () => {
  assert.deepEqual(parseArgs(["hello", "world"]).positionals, ["hello", "world"]);
  assert.deepEqual(parseArgs(["--unknown"]).positionals, ["--unknown"]);
  assert.deepEqual(parseArgs(["-"]).positionals, ["-"]);
  assert.deepEqual(parseArgs(["--", "--looks-like-flag", "x"]).positionals, ["--looks-like-flag", "x"]);
});

test("parseArgs throws when a value option is missing its value", () => {
  assert.throws(() => parseArgs(["--model"], { valueOptions: ["model"] }), /Missing value for --model/);
  assert.throws(() => parseArgs(["-m"], { valueOptions: ["model"], aliasMap: { m: "model" } }), /Missing value for -m/);
});
