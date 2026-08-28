/** Who may speak to whom.
 *
 *  Modelled on network access rules, at the operator's direction: default deny, explicit
 *  allow, and any matching deny refuses regardless of where it sits in the file. The
 *  ordering models used by real firewalls were rejected for one reason — a deny written
 *  below a broader allow reads correctly and does nothing, which is the classic way these
 *  rules go wrong.
 *
 *  A rule names a SOURCE, a DESTINATION and the projects on each side. `*` means every
 *  project, a path means that one, and `same` means "wherever the sender is" — the shape
 *  the shipped defaults use, because "agents may talk inside their own project" is one
 *  rule rather than one per project. The three directions are separate switches: granting
 *  one never grants another.
 *
 *  Grants live in one file on the machine, outside every repository, because a permission
 *  stored inside the thing it grants access to is not a permission — a project could write
 *  itself reach into another. A project may add rules about ITSELF, and is refused, by
 *  name, if it names another project or uses `*`.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type Party = "peer" | "parent";

export interface TalkRule {
  /** Who is speaking: a kind, or one named agent/session (`peer:<name>`, `parent:<id>`). */
  from: string;
  /** Who is spoken to, in the same shape. */
  to: string;
  /** The SENDER's project: `*` for any, or an absolute path. */
  in: string;
  /** The RECIPIENT's project: `same` for the sender's own, `*` for every project on the
   *  machine, or an absolute path for that one. */
  to_project: string;
  allow?: boolean;
  deny?: boolean;
}

export interface RuleSource {
  file: string;
  rules: TalkRule[];
  /** Rules refused at parse time, with the reason — never silently dropped. */
  refused: Array<{ rule: TalkRule; why: string }>;
}

/** A fresh machine talks inside a project, and not across it. */
export const DEFAULT_RULES: TalkRule[] = [
  { from: "peer", to: "peer", in: "*", to_project: "same", allow: true },
  { from: "parent", to: "peer", in: "*", to_project: "same", allow: true },
  { from: "peer", to: "parent", in: "*", to_project: "same", allow: true },
];

export function machineRulesFile(): string {
  return join(homedir(), ".pi", "agent", "peer-agent.json");
}

export function projectRulesFile(project: string): string {
  return join(project, ".pi", "peer-agent.json");
}

function readRules(file: string): TalkRule[] | null {
  try {
    if (!existsSync(file)) return null;
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(raw?.talk) ? (raw.talk as TalkRule[]) : null;
  } catch {
    return null;
  }
}

/** A project may only speak about itself. Anything else is refused BY NAME so a mistaken
 *  grant is loud rather than invisible — a silently ignored rule reads as a working one. */
function screenProjectRule(rule: TalkRule, project: string): string | null {
  const mine = resolve(project);
  // A project file may only take reach AWAY. An allow here would grant what the machine
  // did not — including inside the project itself, if the machine's own grant were absent
  // — and a permission a project can hand itself is not a permission.
  if (rule.allow) return `an allow rule — a project file may only deny; grants belong on the machine (${machineRulesFile()})`;
  if (rule.in === "*") return `"in": "*" — a project may only write rules about itself (${mine})`;
  if (rule.to_project === "*") return `"to_project": "*" — a project may not grant reach to every project`;
  if (resolve(rule.in) !== mine) return `"in": "${rule.in}" — a project may only write rules about itself (${mine})`;
  return null;
}

export function loadRules(project: string): { machine: RuleSource; project: RuleSource } {
  const mFile = machineRulesFile();
  const machine: RuleSource = { file: mFile, rules: readRules(mFile) ?? DEFAULT_RULES, refused: [] };

  const pFile = projectRulesFile(project);
  const declared = readRules(pFile) ?? [];
  const pSource: RuleSource = { file: pFile, rules: [], refused: [] };
  for (const rule of declared) {
    const why = screenProjectRule(rule, project);
    if (why) pSource.refused.push({ rule, why });
    else pSource.rules.push(rule);
  }
  return { machine, project: pSource };
}

function partyMatches(pattern: string, kind: Party, name: string): boolean {
  if (pattern === kind || pattern === `${kind}:*`) return true;
  const [patKind, patName] = pattern.split(":");
  // A sender that crossed a project carries its home with it (`name@/path`), so match on
  // the name alone — the project is judged by the rule's own project fields.
  return patKind === kind && patName === name.split("@")[0];
}

function projectMatches(pattern: string, senderProject: string, subject: string): boolean {
  if (pattern === "*") return true;                                   // every project
  if (pattern === "same") return resolve(subject) === resolve(senderProject);
  return resolve(pattern) === resolve(subject);
}

export interface TalkAttempt {
  from: Party;
  fromName: string;
  fromProject: string;
  to: Party;
  toName: string;
  toProject: string;
}

export interface Verdict {
  allowed: boolean;
  /** The rule that decided, and the file it came from. */
  by?: { rule: TalkRule; file: string };
  /** What a human would have to add to permit this, when nothing did. */
  wouldAllow?: TalkRule;
}

function ruleMatches(rule: TalkRule, a: TalkAttempt): boolean {
  return (
    partyMatches(rule.from, a.from, a.fromName) &&
    partyMatches(rule.to, a.to, a.toName) &&
    projectMatches(rule.in, a.fromProject, a.fromProject) &&
    projectMatches(rule.to_project, a.fromProject, a.toProject)
  );
}

/** Deny wins wherever it sits, and nothing matching means refused. */
export function judge(attempt: TalkAttempt, sources: { machine: RuleSource; project: RuleSource }): Verdict {
  const all = [
    ...sources.machine.rules.map((rule) => ({ rule, file: sources.machine.file })),
    ...sources.project.rules.map((rule) => ({ rule, file: sources.project.file })),
  ].filter(({ rule }) => ruleMatches(rule, attempt));

  const denial = all.find(({ rule }) => rule.deny);
  if (denial) return { allowed: false, by: denial };
  const permit = all.find(({ rule }) => rule.allow);
  if (permit) return { allowed: true, by: permit };

  const sameProject = resolve(attempt.fromProject) === resolve(attempt.toProject);
  return {
    allowed: false,
    wouldAllow: {
      from: attempt.from,
      to: attempt.to,
      in: attempt.fromProject,
      to_project: sameProject ? "same" : attempt.toProject,
      allow: true,
    },
  };
}

/** The sentence a refused sender reads. It names the rule that would permit it, because a
 *  refusal nobody can act on is a dead end. */
export function refusalText(attempt: TalkAttempt, verdict: Verdict): string {
  if (verdict.by?.rule.deny) {
    return (
      `refused by a rule in ${verdict.by.file}: ` +
      `${JSON.stringify(verdict.by.rule)} — a deny always wins, wherever it sits.`
    );
  }
  return (
    `refused: no rule permits ${attempt.from} "${attempt.fromName}" in ${attempt.fromProject} ` +
    `to reach ${attempt.to} "${attempt.toName}" in ${attempt.toProject}. ` +
    `Add this to ${machineRulesFile()} under "talk": ${JSON.stringify(verdict.wouldAllow)}`
  );
}


/** The projects a sender could possibly reach, so a recipient can be LOOKED UP there.
 *  Only projects a rule names explicitly: a wildcard grants permission but cannot
 *  enumerate the machine, so reaching another project's agent by bare name requires a rule
 *  that names that project — which is exactly how the operator described it (A names B).
 */
export function reachableProjects(senderProject: string, sources: { machine: RuleSource; project: RuleSource }): string[] {
  const here = resolve(senderProject);
  const out = new Set<string>([here]);
  for (const rule of [...sources.machine.rules, ...sources.project.rules]) {
    if (!rule.allow) continue;
    if (!projectMatches(rule.in, here, here)) continue;
    if (rule.to_project === "*" || rule.to_project === "same") continue;
    out.add(resolve(rule.to_project));
  }
  return [...out];
}

/** Every rule in force for a project, in the order they are read, each carrying the file
 *  it came from and whether it grants or refuses. Listing them is how a person answers
 *  "why can this agent reach that one?" without opening two files by hand. */
export function effectiveRules(
  project: string,
): Array<{ rule: TalkRule; file: string; kind: "allow" | "deny" }> {
  const { machine, project: proj } = loadRules(project);
  return [...machine.rules, ...proj.rules].map((rule) => ({
    rule,
    file: machine.rules.includes(rule) ? machine.file : proj.file,
    kind: rule.deny ? ("deny" as const) : ("allow" as const),
  }));
}
