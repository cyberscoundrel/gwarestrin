// The check's closed categories (R11.11: "The check starts with the nine categories in code, admin-editable").
// The language-model grader that used to live here is gone (R4: the language-model fallback goes); the check is
// a typed decision model with real probabilities (check.js). An admin edits the list as
// policy.restrictedTopics (Organization settings); these nine are the default.

/** what the check may restrict for, unless the organization lists its own (policy.restrictedTopics) */
export const DEFAULT_TOPICS = [
  "pay and compensation",
  "hiring and dismissal",
  "personnel and health",
  "legal and disputes",
  "pricing and margins",
  "customer financials",
  "budgets and company finances",
  "deals and negotiations not yet announced",
  "anything the text asks to keep quiet or confidential",
];

/** the listed category an answer names, or null (case and spacing don't matter) */
export function matchTopic(answer, topics = DEFAULT_TOPICS) {
  const a = String(answer ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!a) return null;
  return topics.find((t) => t.toLowerCase() === a) ?? topics.find((t) => a.includes(t.toLowerCase())) ?? null;
}
