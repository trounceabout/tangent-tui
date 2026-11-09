// src/mutations.ts
// Changing issues in Linear. This is the ONLY file that writes anything.
//
// RISK: these functions change shared company data. Rules this file enforces:
//  - everything is validated BEFORE anything is sent (a bug elsewhere, or a hostile
//    value from the API, can't become a malformed write)
//  - only three fields can ever be changed: status, priority, estimate
//  - one issue per call, never a batch
//  - Linear's reply is checked against what we asked for
//  - LINEAR_TUI_DRY_RUN=1 sends nothing at all (for trying the UI safely)

import { cleanText, isFinished, linearQuery, safeColor } from "./linear.ts";

// ---------------------------------------------------------------------------
// Team settings: the statuses and estimate scale an issue's team uses.
// (PD and UC have different statuses, so the picker must use the issue's own team.)
// ---------------------------------------------------------------------------
export type TeamState = { id: string; name: string; type: string; position: number; color: string };

export type TeamSettings = {
  key: string;
  states: TeamState[]; // already sorted for display
  estimationType: string; // "tShirt", "fibonacci", "notUsed", ...
  estimationExtended: boolean; // T-shirt scale also has XXL and XXXL
  estimationAllowZero: boolean; // 0 is allowed and means "no estimate"
};

const SETTINGS_QUERY = `
  query TeamSettings($key: String!) {
    teams(filter: { key: { eq: $key } }) {
      nodes {
        key
        issueEstimationType
        issueEstimationExtended
        issueEstimationAllowZero
        states { nodes { id name type position color } }
      }
    }
  }
`;

type SettingsData = {
  teams: {
    nodes: {
      key: string;
      issueEstimationType: string;
      issueEstimationExtended: boolean;
      issueEstimationAllowZero: boolean;
      states: { nodes: TeamState[] };
    }[];
  };
};

// Status types in the order a picker shows them: not-started first, finished last.
const STATE_TYPE_ORDER = ["triage", "backlog", "unstarted", "started", "completed", "canceled", "duplicate"];
const stateRank = (type: string) => {
  const index = STATE_TYPE_ORDER.indexOf(type);
  return index === -1 ? STATE_TYPE_ORDER.length : index;
};

export const sortStates = (states: TeamState[]): TeamState[] =>
  [...states].sort((a, b) => stateRank(a.type) - stateRank(b.type) || a.position - b.position);

const TEAM_KEY = /^[A-Z][A-Z0-9]*$/;

export async function fetchTeamSettings(apiKey: string, teamKey: string): Promise<TeamSettings> {
  if (!TEAM_KEY.test(teamKey)) throw new Error(`"${cleanText(teamKey)}" is not a valid team key`);
  const data = await linearQuery<SettingsData>(apiKey, SETTINGS_QUERY, { key: teamKey });
  const team = data.teams.nodes[0];
  if (!team) throw new Error(`Team ${teamKey} was not found`);
  // Everything from the network is cleaned, like in linear.ts.
  return {
    key: cleanText(team.key),
    estimationType: cleanText(team.issueEstimationType),
    estimationExtended: team.issueEstimationExtended === true,
    estimationAllowZero: team.issueEstimationAllowZero === true,
    states: sortStates(
      team.states.nodes.map((s) => ({
        id: cleanText(s.id),
        name: cleanText(s.name),
        type: cleanText(s.type),
        position: s.position,
        color: safeColor(s.color),
      })),
    ),
  };
}

// ---------------------------------------------------------------------------
// What the pickers offer
// ---------------------------------------------------------------------------
export type Option<T> = {
  value: T;
  label: string;
  color?: string; // a dot in Linear's own color, for statuses
  finished?: boolean; // moving here finishes the work (Done, Canceled, ...)
};

export const statusOptions = (settings: TeamSettings): Option<string>[] =>
  settings.states.map((s) => ({ value: s.id, label: s.name, color: s.color, finished: isFinished(s.type) }));

export const PRIORITY_OPTIONS: Option<number>[] = [
  { value: 1, label: "Urgent" },
  { value: 2, label: "High" },
  { value: 3, label: "Medium" },
  { value: 4, label: "Low" },
  { value: 0, label: "No priority" },
];

// Estimates are only supported for T-shirt teams (PD and UC). For any other scale
// this returns null, and the app says so instead of guessing.
export function estimateOptions(settings: TeamSettings): Option<number>[] | null {
  if (settings.estimationType !== "tShirt") return null;
  const sizes: Option<number>[] = [
    { value: 1, label: "XS" },
    { value: 2, label: "S" },
    { value: 3, label: "M" },
    { value: 5, label: "L" },
    { value: 8, label: "XL" },
  ];
  if (settings.estimationExtended) sizes.push({ value: 13, label: "XXL" }, { value: 21, label: "XXXL" });
  return settings.estimationAllowZero ? [{ value: 0, label: "No estimate" }, ...sizes] : sizes;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
export type IssueChange = { stateId?: string; priority?: number; estimate?: number };

const IDENTIFIER = /^[A-Z][A-Z0-9]*-\d+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_FIELDS = new Set(["stateId", "priority", "estimate"]);

// Throws a clear error for anything we shouldn't send. Returns the cleaned input:
// only the three allowed fields, and no undefined ones.
export function validateChange(identifier: string, change: IssueChange): IssueChange {
  if (!IDENTIFIER.test(identifier)) throw new Error(`"${cleanText(identifier)}" is not a valid issue ID`);

  const entries = Object.entries(change).filter(([, value]) => value !== undefined);
  if (entries.length === 0) throw new Error("There is nothing to change");
  for (const [field] of entries) {
    if (!ALLOWED_FIELDS.has(field)) throw new Error(`The field "${cleanText(field)}" can't be changed from here`);
  }

  const { stateId, priority, estimate } = change;
  if (stateId !== undefined && !UUID.test(stateId)) throw new Error("That is not a valid status");
  if (priority !== undefined && !(Number.isInteger(priority) && priority >= 0 && priority <= 4)) {
    throw new Error("Priority must be a whole number from 0 to 4");
  }
  if (estimate !== undefined && !(Number.isInteger(estimate) && estimate >= 0 && estimate <= 21)) {
    throw new Error("Estimate must be a whole number from 0 to 21");
  }

  const clean: IssueChange = {};
  if (stateId !== undefined) clean.stateId = stateId;
  if (priority !== undefined) clean.priority = priority;
  if (estimate !== undefined) clean.estimate = estimate;
  return clean;
}

// ---------------------------------------------------------------------------
// The write
// ---------------------------------------------------------------------------
const UPDATE_MUTATION = `
  mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) {
      success
      issue {
        identifier
        priority
        estimate
        state { id name type color }
      }
    }
  }
`;

type UpdateData = {
  issueUpdate: {
    success: boolean;
    issue: {
      identifier: string;
      priority: number;
      estimate: number | null;
      state: { id: string; name: string; type: string; color: string };
    } | null;
  };
};

export type UpdatedIssue = NonNullable<UpdateData["issueUpdate"]["issue"]>;
export type UpdateResult = { dryRun: true } | { dryRun: false; issue: UpdatedIssue };

// With LINEAR_TUI_DRY_RUN=1 nothing is ever sent. Useful for trying the screens.
export const isDryRun = (): boolean => process.env.LINEAR_TUI_DRY_RUN === "1";

export async function updateIssue(apiKey: string, identifier: string, change: IssueChange): Promise<UpdateResult> {
  const input = validateChange(identifier, change); // throws BEFORE anything is sent
  if (isDryRun()) return { dryRun: true };

  const data = await linearQuery<UpdateData>(apiKey, UPDATE_MUTATION, { id: identifier, input });
  const result = data.issueUpdate;
  if (!result.success || !result.issue) throw new Error("Linear did not apply the change");

  const issue: UpdatedIssue = {
    identifier: cleanText(result.issue.identifier),
    priority: result.issue.priority,
    estimate: result.issue.estimate,
    state: {
      id: cleanText(result.issue.state.id),
      name: cleanText(result.issue.state.name),
      type: cleanText(result.issue.state.type),
      color: safeColor(result.issue.state.color),
    },
  };

  // Don't just trust "success": check Linear applied what we asked for.
  const wrong: string[] = [];
  if (input.stateId !== undefined && issue.state.id !== input.stateId) wrong.push("status");
  if (input.priority !== undefined && issue.priority !== input.priority) wrong.push("priority");
  if (input.estimate !== undefined && (issue.estimate ?? 0) !== input.estimate) wrong.push("estimate");
  if (wrong.length > 0) throw new Error(`Linear reported a different ${wrong.join(" and ")} than was requested`);

  return { dryRun: false, issue };
}
