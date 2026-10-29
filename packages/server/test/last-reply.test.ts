import { describe, expect, it } from "vitest";
import { lastReply } from "../src/agents/last-reply.js";

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const said = (text: string, extra = {}) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", ...extra });
const tool = () => ({ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "graph-rag_search_graph", arguments: {} }], stopReason: "toolUse" });
const result = () => ({ role: "toolResult", content: [{ type: "text", text: "rows" }] });

describe("lastReply", () => {
  it("is the last thing said in the latest turn", () => {
    expect(lastReply([user("hi"), said("old"), user("status?"), tool(), result(), said("The report.")])).toBe("The report.");
  });

  it("reads past a turn that ends on a tool call or thinking alone", () => {
    expect(lastReply([user("go"), said("Here's the situation: A or B?"), tool(), result()])).toBe("Here's the situation: A or B?");
    const thinking = { role: "assistant", content: [{ type: "thinking", thinking: "…" }], stopReason: "stop" };
    expect(lastReply([user("go"), said("Report."), thinking])).toBe("Report.");
  });

  it("never answers with what was said before the latest prompt", () => {
    expect(lastReply([user("a"), said("answer to a"), user("b"), tool(), result()])).toBe("");
  });

  it("says so when the turn ended in an error, instead of nothing", () => {
    const err = { role: "assistant", content: [], stopReason: "error", errorMessage: "402 out of credit" };
    expect(lastReply([user("go"), err])).toBe("(no reply: the turn ended with an error: 402 out of credit)");
    expect(lastReply([user("go"), said("Half a report"), err])).toBe("Half a report\n\n(the turn ended with an error: 402 out of credit after this)");
    expect(lastReply([user("go"), { role: "assistant", content: [], stopReason: "aborted" }])).toBe("(no reply: the turn was stopped)");
  });

  it("takes plain-string content and junk", () => {
    expect(lastReply([user("x"), { role: "assistant", content: "plain" }])).toBe("plain");
    expect(lastReply([])).toBe("");
    expect(lastReply(null as unknown as unknown[])).toBe("");
  });
});
