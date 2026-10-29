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

/**
 * The latest turn: what it last said, and why it ended badly if it did (a
 * model error after pi's own retries, or a stop), whether or not it wrote
 * something first. A turn that ended badly hasn't finished its work, even
 * when it left text behind.
 */
export function lastTurn(messages: unknown[]): { text: string; ended: string | null } {
  const list = (Array.isArray(messages) ? messages : []) as Message[];
  // the latest turn: everything after the last message from its user
  let start = list.length;
  while (start > 0 && list[start - 1]?.role !== "user") start--;
  const turn = list.slice(start).filter((m) => m?.role === "assistant");
  let text = "";
  for (let i = turn.length - 1; i >= 0 && !text; i--) text = textOf(turn[i]!).trim();
  const last = turn.at(-1);
  const ended =
    last && (last.stopReason === "error" || last.stopReason === "aborted")
      ? last.stopReason === "aborted"
        ? "the turn was stopped"
        : `the turn ended with an error${last.errorMessage ? `: ${String(last.errorMessage).slice(0, 300)}` : ""}`
      : null;
  return { text, ended };
}

export function lastReply(messages: unknown[]): string {
  const list = (Array.isArray(messages) ? messages : []) as Message[];
  const { text, ended } = lastTurn(list);
  const last = list.filter((m) => m?.role === "assistant").at(-1);
  // an error that left its own text is reported as that text (it said what went wrong)
  if (ended && last && !textOf(last).trim()) return text ? `${text}\n\n(${ended} after this)` : `(no reply: ${ended})`;
  return text;
}
