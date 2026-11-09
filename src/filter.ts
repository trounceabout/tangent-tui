// src/filter.ts
// Filtering and searching the issue list. Pure functions only (no UI, no network),
// so every rule can be tested on its own.

import type { Issue } from "./linear.ts";

// ---------------------------------------------------------------------------
// The filters you can set
// ---------------------------------------------------------------------------
export type Filters = {
  // Free text from the "/" search bar. Plain words match the issue ID or title;
  // "label:cpq" matches label names; "team:pd" matches the team key.
  query: string;
  // Team key (e.g. "PD") picked with the `t` key, or null for all teams.
  team: string | null;
  // "At least this urgent": 1 = Urgent only, 2 = High and above, 3 = Medium and
  // above. null = any priority. (Issues with no priority never match a priority filter.)
  minPriority: number | null;
  // Exact label name picked with the `L` key, or null for all labels.
  label: string | null;
};

export const NO_FILTERS: Filters = { query: "", team: null, minPriority: null, label: null };

// Longest search string we accept. Keeps typing and matching cheap.
export const MAX_QUERY_CHARS = 100;

export const isFiltering = (filters: Filters): boolean =>
  filters.query.trim() !== "" || filters.team !== null || filters.minPriority !== null || filters.label !== null;

// ---------------------------------------------------------------------------
// Parsing the search string
// ---------------------------------------------------------------------------

type ParsedQuery = { words: string[]; labels: string[]; teams: string[] };

// Split on spaces into plain words and "label:"/"team:" operators. Everything is
// lower-cased so matching ignores case. A word like "foo:bar" with an unknown
// operator is treated as plain text.
export function parseQuery(query: string): ParsedQuery {
  const parsed: ParsedQuery = { words: [], labels: [], teams: [] };
  for (const token of query.toLowerCase().split(/\s+/)) {
    if (token === "") continue;
    const operator = /^(label|l|team|t):(.+)$/.exec(token);
    const name = operator?.[1];
    const value = operator?.[2];
    if (name === undefined || value === undefined) parsed.words.push(token);
    else if (name === "label" || name === "l") parsed.labels.push(value);
    else parsed.teams.push(value);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Applying the filters
// ---------------------------------------------------------------------------
export function filterIssues(issues: Issue[], filters: Filters): Issue[] {
  const { words, labels, teams } = parseQuery(filters.query);

  return issues.filter((issue) => {
    if (filters.team !== null && issue.team.key !== filters.team) return false;
    if (filters.minPriority !== null && !(issue.priority >= 1 && issue.priority <= filters.minPriority)) return false;
    if (filters.label !== null && !issue.labels.nodes.some((label) => label.name === filters.label)) return false;

    // Plain words: every word must appear in the ID or the title.
    const haystack = `${issue.identifier} ${issue.title}`.toLowerCase();
    if (!words.every((word) => haystack.includes(word))) return false;
    // label:x  -> some label name contains x.   team:x -> the team key is exactly x.
    if (!labels.every((q) => issue.labels.nodes.some((label) => label.name.toLowerCase().includes(q)))) return false;
    if (!teams.every((q) => issue.team.key.toLowerCase() === q)) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Cycling through values with a single key
// ---------------------------------------------------------------------------

// All -> option 1 -> option 2 -> ... -> All. If the current value has disappeared
// (e.g. after a refresh), start again from the first option.
function cycle(options: string[], current: string | null): string | null {
  if (current === null) return options[0] ?? null;
  const index = options.indexOf(current);
  return index === -1 ? (options[0] ?? null) : (options[index + 1] ?? null);
}

export const nextTeam = (issues: Issue[], current: string | null): string | null =>
  cycle([...new Set(issues.map((issue) => issue.team.key))].sort(), current);

export const nextLabel = (issues: Issue[], current: string | null): string | null =>
  cycle([...new Set(issues.flatMap((issue) => issue.labels.nodes.map((label) => label.name)))].sort(), current);

// Any -> Urgent -> High+ -> Medium+ -> Any.
export const nextPriority = (current: number | null): number | null => (current === null ? 1 : current >= 3 ? null : current + 1);

// ---------------------------------------------------------------------------
// Describing the active filters for the footer
// ---------------------------------------------------------------------------
const PRIORITY_FILTER_TEXT: Record<number, string> = { 1: "Urgent", 2: "≥ High", 3: "≥ Medium" };

export function describeFilters(filters: Filters): string {
  const parts: string[] = [];
  if (filters.query.trim() !== "") parts.push(`"${filters.query.trim()}"`);
  if (filters.team !== null) parts.push(`team ${filters.team}`);
  if (filters.minPriority !== null) parts.push(PRIORITY_FILTER_TEXT[filters.minPriority] ?? "priority");
  if (filters.label !== null) parts.push(`label ${filters.label}`);
  return parts.join(" · ");
}
