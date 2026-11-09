// src/keys.ts
// Helper for keyboard input.
//
// Ink calls our key handler once per chunk of input. Normally that's one key. But
// when several characters arrive in a single chunk (a held-down key, or fast
// typing while the app is busy), Ink hands us the whole string at once, as if it
// were pasted text: "jjj" instead of three separate "j" presses. A handler that
// checks `input === "j"` would then ignore all of them.

// Characters that are safe to treat as repeated presses. Deliberately only
// navigation keys: a burst of "o" must NOT open several browser tabs.
const REPEATABLE = new Set(["j", "k", "h", "l", " ", "b"]);

// Turn one chunk of input into the list of key presses it stands for.
//  - one character (or none, like an arrow key) -> as is
//  - a run of the same navigation key ("jjj")   -> one press per character
//  - anything else (e.g. pasted text)           -> ignored, so a paste can never
//                                                  trigger actions
export function expandBurst(input: string): string[] {
  if (input.length <= 1) return [input];
  const first = input[0] ?? "";
  return REPEATABLE.has(first) && [...input].every((char) => char === first) ? [...input] : [];
}
