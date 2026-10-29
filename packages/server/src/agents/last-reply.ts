/**
 * What an agent last said, from its messages (pi's get_messages). pi's own
 * get_last_assistant_text reads only the very last assistant message, so a
 * turn that ends on a tool call, on thinking alone, or on an error comes
 * back blank even when the agent wrote its report one message earlier.
 * This reads the newest text of the latest turn (never from before the last
 * prompt, which would be an earlier answer), and says so when the turn
 * ended in an error instead of returning nothing.
 */
interface Block {
  type?: string;
  text?: string;
}
interface Message {
  role?: string;
  content?: Block[] | string;
  stopReason?: string;
  errorMessage?: string;
}

const textOf = (m: Message): string =>
  typeof m.content === "string" ? m.content : (m.content ?? []).filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("");

export function lastReply(messages: unknown[]): string {
  const list = (Array.isArray(messages) ? messages : []) as Message[];
  // the latest turn: everything after the last message from its user
  let start = list.length;
  while (start > 0 && list[start - 1]?.role !== "user") start--;
  const turn = list.slice(start).filter((m) => m?.role === "assistant");
  let text = "";
  for (let i = turn.length - 1; i >= 0 && !text; i--) text = textOf(turn[i]!).trim();
  const last = turn.at(-1);
  const failed = last && (last.stopReason === "error" || last.stopReason === "aborted") && !textOf(last).trim();
  if (failed) {
    const why = last.stopReason === "aborted" ? "the turn was stopped" : `the turn ended with an error${last.errorMessage ? `: ${String(last.errorMessage).slice(0, 300)}` : ""}`;
    return text ? `${text}\n\n(${why} after this)` : `(no reply: ${why})`;
  }
  return text;
}
