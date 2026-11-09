// src/edit.ts
// The pure logic behind the edit screens: what each picker offers, what the confirm
// screen says, and exactly what change gets sent. No UI and no network here, so it
// can be tested on its own. (The actual write is in mutations.ts.)

import { formatEstimate } from "./linear.ts";
import type { Issue } from "./linear.ts";
import { PRIORITY_OPTIONS, estimateOptions, statusOptions } from "./mutations.ts";
import type { IssueChange, Option, TeamSettings } from "./mutations.ts";

export type EditKind = "status" | "priority" | "estimate";
export type EditOption = Option<string | number>;

export const EDIT_TITLE: Record<EditKind, string> = {
  status: "Change status",
  priority: "Change priority",
  estimate: "Change estimate",
};
export const EDIT_FIELD: Record<EditKind, string> = { status: "Status", priority: "Priority", estimate: "Estimate" };

// Status and estimate need the issue's team settings (its statuses, its scale).
export const needsTeamSettings = (kind: EditKind): boolean => kind !== "priority";

// ---------------------------------------------------------------------------
// What the picker offers
// ---------------------------------------------------------------------------
export type Offer = { options: EditOption[] } | { unsupported: string };

export function buildOptions(kind: EditKind, issue: Issue, settings: TeamSettings | null): Offer {
  if (kind === "priority") return { options: PRIORITY_OPTIONS };

  if (settings === null) return { unsupported: "This team's settings couldn't be loaded." };
  // SAFETY: a status id from another team's workflow would be wrong for this issue.
  if (settings.key !== issue.team.key) {
    return { unsupported: `Settings for team ${settings.key} can't be used for a ${issue.team.key} issue.` };
  }

  if (kind === "status") {
    const options = statusOptions(settings);
    return options.length > 0 ? { options } : { unsupported: `Team ${settings.key} has no statuses.` };
  }

  const options = estimateOptions(settings);
  return options
    ? { options }
    : { unsupported: `Team ${settings.key} uses the "${settings.estimationType}" estimate scale, which isn't supported yet.` };
}

// ---------------------------------------------------------------------------
// The issue's current value
// ---------------------------------------------------------------------------
export function currentLabel(kind: EditKind, issue: Issue): string {
  if (kind === "status") return issue.state.name;
  if (kind === "priority") return PRIORITY_OPTIONS.find((o) => o.value === issue.priority)?.label ?? "No priority";
  return formatEstimate(issue) || "No estimate";
}

// Is this option what the issue already has?
export function isCurrent(kind: EditKind, issue: Issue, option: EditOption): boolean {
  if (kind === "status") return option.label === issue.state.name; // names are unique within a team
  if (kind === "priority") return option.value === issue.priority;
  return option.value === (issue.estimate ?? 0); // null and 0 both mean "no estimate"
}

// Where the cursor starts: on the current value, so one keypress moves away from it.
export const startIndex = (kind: EditKind, issue: Issue, options: EditOption[]): number =>
  Math.max(0, options.findIndex((option) => isCurrent(kind, issue, option)));

// ---------------------------------------------------------------------------
// What gets sent, and what the confirm screen says
// ---------------------------------------------------------------------------

// The exact change for a chosen option. Throws if the option's value is the wrong
// type for the field, so a mix-up can never reach the network.
export function changeFor(kind: EditKind, option: EditOption): IssueChange {
  if (kind === "status") {
    if (typeof option.value !== "string") throw new Error("A status must be chosen by its id");
    return { stateId: option.value };
  }
  if (typeof option.value !== "number") throw new Error(`A ${kind} must be a number`);
  return kind === "priority" ? { priority: option.value } : { estimate: option.value };
}

// Moving to a finishing status gets an extra warning (the user's process needs a
// validation comment before work is called done).
export function warningFor(kind: EditKind, option: EditOption): string | null {
  if (kind === "status" && option.finished) {
    return "This marks the work as finished. Your process needs a validation comment first: post it in Linear before finishing (press o to open the issue).";
  }
  return null;
}

// One line for the "done" message: "PD-3066: Todo → In Progress".
export const describeChange = (kind: EditKind, issue: Issue, option: EditOption): string =>
  `${issue.identifier}: ${currentLabel(kind, issue)} → ${option.label}`;
