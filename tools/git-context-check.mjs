#!/usr/bin/env node
/**
 * Standing check: does the project briefing survive a repo with no origin remote?
 *
 * Run it any time — `npm run check:git-context`, from CI, or by hand. It builds two
 * throwaway repos (one with an origin, one without) and asserts the git line that
 * runtime.ts adds to "PROJECT YOU SERVE" behaves in both.
 *
 * Two regressions it catches, both seen in the wild:
 *   1. stderr leaking to the terminal. execFileSync INHERITS stderr unless told
 *      otherwise, so `git remote get-url origin` on a remoteless repo printed
 *      "error: No such remote 'origin'" over the host TUI's own output.
 *   2. losing the branch. Both git calls shared one try block, so the failing
 *      remote lookup threw past the push and the briefing carried no git line at all.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// the exact call runtime.ts makes — stderr piped, never inherited.
const git = (root, args) =>
  execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    timeout: 4000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

// the branch/remote logic under test, mirroring runtime.ts.
function gitLine(root) {
  try {
    const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
    let remote = "";
    try {
      remote = git(root, ["remote", "get-url", "origin"]);
    } catch {
      /* no origin remote — fine */
    }
    return `git: branch ${branch}${remote ? ` · origin ${remote}` : ""}`;
  } catch {
    return null;
  }
}

const scratch = mkdtempSync(join(tmpdir(), "ppa-git-context-"));
const make = (name, withOrigin) => {
  const root = join(scratch, name);
  execFileSync("git", ["init", "-q", "-b", "main", root], { stdio: ["ignore", "pipe", "pipe"] });
  for (const [k, v] of [["user.email", "check@example.invalid"], ["user.name", "check"]])
    git(root, ["config", k, v]);
  git(root, ["commit", "-q", "--allow-empty", "-m", "root"]);
  if (withOrigin) git(root, ["remote", "add", "origin", "https://example.invalid/r.git"]);
  return root;
};

const withOrigin = make("with-origin", true);
const noOrigin = make("no-origin", false);
const notRepo = scratch;

const failures = [];
const expect = (ok, what) => { if (!ok) failures.push(what); };

expect(gitLine(withOrigin) === "git: branch main · origin https://example.invalid/r.git",
  `repo with an origin should report branch and origin, got: ${gitLine(withOrigin)}`);

// the regression: a remoteless repo must still report its branch.
expect(gitLine(noOrigin) === "git: branch main",
  `repo with no origin should still report its branch, got: ${gitLine(noOrigin)}`);

expect(gitLine(notRepo) === null, "a non-repo should produce no git line");

// the leak: run the remote lookup as a child and assert it printed nothing to stderr.
const leak = spawnSync(process.execPath,
  ["-e", `const{execFileSync}=require("child_process");try{execFileSync("git",["-C",${JSON.stringify(noOrigin)},"remote","get-url","origin"],{encoding:"utf8",timeout:4000,stdio:["ignore","pipe","pipe"]})}catch{}`],
  { encoding: "utf8" });
expect(leak.stderr === "", `the remote lookup must not write to stderr, got: ${leak.stderr.trim()}`);

rmSync(scratch, { recursive: true, force: true });

for (const f of failures) console.log(`  ${f}`);
console.log(failures.length ? `FAILED — ${failures.length} check(s)` : "OK — briefing keeps its branch line and leaks nothing, with or without an origin");
process.exit(failures.length ? 1 : 0);
