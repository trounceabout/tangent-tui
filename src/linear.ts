// src/linear.ts
// The DATA layer: fetches my issues from Linear and prepares them for display.
// It returns plain values only (hex colors, numbers, strings). All styling
// belongs to the UI components, so nothing in here knows about terminals.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type Issue = {
  identifier: string; // e.g. "PD-3066"
  title: string;
  url: string; // used by the "open in browser" key
  priority: number; // Linear: 0 = none, 1 = urgent, 2 = high, 3 = medium, 4 = low
  state: { name: string; type: string; position: number; color: string };
  cycle: { number: number; endsAt: string; team: { key: string } };
  dueDate: string | null; // "YYYY-MM-DD", or null
  estimate: number | null; // numeric; its meaning depends on the team's scale
  labels: { nodes: { name: string; color: string }[] };
  team: { key: string; issueEstimationType: string }; // "tShirt", "fibonacci", "notUsed", ...
};

// One status column on the board (e.g. "In Review") and the issues inside it.
export type StatusGroup = {
  name: string;
  type: string; // Linear's state type: started, unstarted, completed, ...
  color: string; // hex, straight from Linear
  issues: Issue[];
};

// Progress for one active cycle, counting only MY issues.
export type CycleProgress = {
  label: string; // e.g. "PD #111"
  done: number;
  total: number; // canceled issues excluded
  percent: number; // whole number, 0-100
  endsAt: string;
};

// ---------------------------------------------------------------------------
// Cleaning text that came over the network
//
// Issue titles, label names and so on are written by OTHER people (teammates,
// integrations, customers). They get printed to the terminal, so a hostile one
// could carry escape sequences. Ink already filters some, but it deliberately
// keeps color/style and hyperlink sequences, and we shouldn't depend on a
// library's filter staying the same. So we clean everything once, right here
// where the data enters the program.
// ---------------------------------------------------------------------------

// \p{Cc} = every control character: ESC, BEL, tabs, newlines, and the C1 range.
const CONTROL_CHARS = /\p{Cc}/gu;
// Bidirectional overrides can make text DISPLAY in a different order than it
// is stored, e.g. to fake another issue ID.
const BIDI_CONTROLS = /[‎‏‪-‮⁦-⁩]/g;

// Make a string safe to print: control characters become spaces (so a newline
// in a title doesn't glue two words together), bidi overrides are dropped.
export function cleanText(text: string): string {
  return text.replace(CONTROL_CHARS, " ").replace(BIDI_CONTROLS, "");
}

// Same idea for long text (descriptions, comments): keep the line breaks, but
// turn every other control character into a space. Used by detail.ts.
export function cleanMultiline(text: string): string {
  return text
    .replace(/\r\n?/g, "\n") // normalise Windows/old-Mac line endings
    .replace(/(?!\n)\p{Cc}/gu, " ") // any control character except newline
    .replace(BIDI_CONTROLS, "");
}

// Colors go straight into the UI, so only accept a plain "#rrggbb" hex code.
const FALLBACK_COLOR = "#8a8f98";
const safeColor = (color: string) => (/^#[0-9a-fA-F]{6}$/.test(color) ? color : FALLBACK_COLOR);

// Return a copy of an issue with every network-supplied string cleaned.
function sanitizeIssue(issue: Issue): Issue {
  return {
    ...issue,
    identifier: cleanText(issue.identifier),
    title: cleanText(issue.title),
    url: cleanText(issue.url),
    state: { ...issue.state, name: cleanText(issue.state.name), type: cleanText(issue.state.type), color: safeColor(issue.state.color) },
    cycle: { ...issue.cycle, endsAt: cleanText(issue.cycle.endsAt), team: { key: cleanText(issue.cycle.team.key) } },
    dueDate: issue.dueDate === null ? null : cleanText(issue.dueDate),
    labels: {
      nodes: issue.labels.nodes.map((label) => ({ name: cleanText(label.name), color: safeColor(label.color) })),
    },
    team: { key: cleanText(issue.team.key), issueEstimationType: cleanText(issue.team.issueEstimationType) },
  };
}

// ---------------------------------------------------------------------------
// API key + fetching
// ---------------------------------------------------------------------------

// Read the API key from the macOS Keychain (service "linear-api-key").
// `-w` makes `security` print only the password so we can capture it.
export async function getApiKey(): Promise<string> {
  const proc = Bun.spawn(["security", "find-generic-password", "-s", "linear-api-key", "-w"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = (await new Response(proc.stdout).text()).trim();
  if ((await proc.exited) !== 0 || !out) {
    throw new Error("Couldn't read 'linear-api-key' from the Keychain.");
  }
  return out;
}

// Issues assigned to me in any cycle that is currently active. Linear decides
// what "active" means, so this survives cycle rollover with no hard-coded IDs.
const QUERY = `
  query MyCycleIssues($after: String) {
    viewer {
      assignedIssues(
        first: 100
        after: $after
        filter: { cycle: { isActive: { eq: true } } }
      ) {
        pageInfo { hasNextPage endCursor }
        nodes {
          identifier
          title
          url
          priority
          state { name type position color }
          dueDate
          estimate
          labels { nodes { name color } }
          team { key issueEstimationType }
          cycle { number endsAt team { key } }
        }
      }
    }
  }
`;

// Send one GraphQL request to Linear and return its `data`. Shared by every
// query we make, so the URL, auth header and error handling live in one place.
// `T` is the shape we expect `data` to have; spelling it out lets TypeScript
// check the code that uses it.
export async function linearQuery<T>(
  apiKey: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const res: Response = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Personal API keys go in as-is. Do NOT prefix with "Bearer ".
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) throw new Error(`Linear API returned HTTP ${res.status}`);
  const json = (await res.json()) as { data?: T; errors?: unknown };
  if (json.errors) throw new Error(`Linear API error: ${JSON.stringify(json.errors)}`);
  if (!json.data) throw new Error("Linear API returned no data");
  return json.data;
}

// The shape of Linear's reply to the issues query above.
type IssuesData = {
  viewer: {
    assignedIssues: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: Issue[];
    };
  };
};

// Fetch every page (Linear returns at most 100 per request).
export async function fetchIssues(apiKey: string): Promise<Issue[]> {
  const issues: Issue[] = [];
  let after: string | null = null;

  while (true) {
    const data: IssuesData = await linearQuery<IssuesData>(apiKey, QUERY, { after });
    const page = data.viewer.assignedIssues;
    issues.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) break;
    after = page.pageInfo.endCursor;
  }
  // Clean everything at the boundary, before any other code sees it.
  return issues.map(sanitizeIssue);
}

// ---------------------------------------------------------------------------
// Grouping + sorting
// ---------------------------------------------------------------------------

// Active work first, finished work last.
const TYPE_RANK: Record<string, number> = {
  started: 0,
  unstarted: 1,
  backlog: 2,
  triage: 3,
  completed: 4,
  canceled: 5,
};

// A status type we don't recognise sorts to the end rather than crashing.
const typeRank = (type: string) => TYPE_RANK[type] ?? 99;

// Linear uses 0 for "no priority", but that should sort LAST, not first.
const priorityRank = (p: number) => (p === 0 ? 5 : p);

// Statuses that start collapsed. Matched by NAME (not the "completed" type) so
// actionable ones like "Ready to Release" stay open.
export const COLLAPSED_STATUSES = new Set(["Done", "Canceled", "Duplicate"]);

// Finished work gets muted styling.
export const isFinished = (type: string) => type === "completed" || type === "canceled";

// Group by status name, order the groups like Linear does, and sort the issues
// inside each group by priority (then by issue number).
export function groupIssues(issues: Issue[]): StatusGroup[] {
  const byName = new Map<string, StatusGroup>();
  for (const issue of issues) {
    const group = byName.get(issue.state.name) ?? {
      name: issue.state.name,
      type: issue.state.type,
      color: issue.state.color,
      issues: [],
    };
    group.issues.push(issue);
    byName.set(issue.state.name, group);
  }

  // A group always has at least one issue (it's created when one is added),
  // but TypeScript can't know that, so fall back to 0.
  const position = (g: StatusGroup) => g.issues[0]?.state.position ?? 0;
  const groups = [...byName.values()].sort(
    (a, b) => typeRank(a.type) - typeRank(b.type) || position(a) - position(b),
  );

  for (const group of groups) {
    group.issues.sort(
      (a, b) =>
        priorityRank(a.priority) - priorityRank(b.priority) ||
        a.identifier.localeCompare(b.identifier, undefined, { numeric: true }),
    );
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Cycle progress
// ---------------------------------------------------------------------------

export function cycleProgress(issues: Issue[]): CycleProgress[] {
  // Remember each cycle's end date from its first issue, so we never have to
  // index into a list that might (in theory) be empty.
  const byCycle = new Map<string, { endsAt: string; list: Issue[] }>();
  for (const issue of issues) {
    const key = `${issue.cycle.team.key} #${issue.cycle.number}`;
    const entry = byCycle.get(key) ?? { endsAt: issue.cycle.endsAt, list: [] };
    entry.list.push(issue);
    byCycle.set(key, entry);
  }

  return [...byCycle.entries()].map(([label, { endsAt, list }]) => {
    const total = list.filter((i) => i.state.type !== "canceled").length;
    const done = list.filter((i) => i.state.type === "completed").length;
    return {
      label,
      done,
      total,
      percent: total === 0 ? 0 : Math.round((done / total) * 100),
      endsAt,
    };
  });
}

// "ends tomorrow", "3 days left", etc. Compares calendar days (local time), so
// the wording doesn't flip partway through a day.
export function daysLeft(endsAt: string): string {
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(new Date(endsAt)) - startOfDay(new Date())) / 86_400_000);
  if (days < 0) return "ended";
  if (days === 0) return "ends today";
  if (days === 1) return "ends tomorrow";
  return `${days} days left`;
}

// ---------------------------------------------------------------------------
// Estimates + due dates
// ---------------------------------------------------------------------------

// Linear's documented T-shirt point values. (13 and 21 only appear on teams
// with "extended" scales.) 0 / null means "no estimate".
const TSHIRT: Record<number, string> = { 1: "XS", 2: "S", 3: "M", 5: "L", 8: "XL", 13: "XXL", 21: "XXXL" };

// Show the estimate the way the issue's TEAM scores it: T-shirt letters for
// tShirt teams (PD, UC), plain numbers for any other scale.
export function formatEstimate(issue: Issue): string {
  if (!issue.estimate) return ""; // null or 0 = no estimate
  if (issue.team.issueEstimationType === "tShirt") {
    return TSHIRT[issue.estimate] ?? String(issue.estimate);
  }
  return String(issue.estimate);
}

// "due Nov 12", plus whether it's overdue. Finished issues are never overdue.
export function formatDue(issue: Issue): { text: string; overdue: boolean } | null {
  if (!issue.dueDate) return null;
  // Build the date from its parts so it's local midnight (new Date("2026-11-12")
  // would be UTC and could land on the wrong day).
  const [y, m, d] = issue.dueDate.split("-").map(Number);
  // A malformed date means "no usable due date", not a made-up one.
  if (y === undefined || m === undefined || d === undefined) return null;
  const date = new Date(y, m - 1, d);
  // Pieces that aren't numbers ("a-b-c") produce an invalid date: also unusable.
  if (Number.isNaN(date.getTime())) return null;
  const text = `due ${date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return { text, overdue: !isFinished(issue.state.type) && date < today };
}
