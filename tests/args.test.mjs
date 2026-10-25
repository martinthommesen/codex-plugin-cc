import test from "node:test";
import assert from "node:assert/strict";

import { parseArgs, splitRawArgumentString } from "../plugins/codex/scripts/lib/args.mjs";

test("inline option values keep every character after the first equals sign", () => {
  const { options } = parseArgs(["--prompt-file=notes/a=b.md"], { valueOptions: ["prompt-file"] });
  assert.equal(options["prompt-file"], "notes/a=b.md");
});

test("an unmatched apostrophe does not swallow later flags", () => {
  const tokens = splitRawArgumentString("don't trust the cache --base main");
  const { options, positionals } = parseArgs(tokens, { valueOptions: ["base"] });
  assert.equal(options.base, "main");
  assert.deepEqual(positionals, ["don't", "trust", "the", "cache"]);
});

test("task text after -- is passed through verbatim", () => {
  const { options, positionals } = parseArgs(["--write", "--", "explain why --resume is ignored"], {
    booleanOptions: ["write", "resume"]
  });
  assert.deepEqual(options, { write: true });
  assert.deepEqual(positionals, ["explain why --resume is ignored"]);
});
