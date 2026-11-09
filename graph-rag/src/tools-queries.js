/**
 * The Queries stream's tools and routes (docs/ORGANIZATION-MODEL.md, the "Search" and "Needs" rows):
 * the current state of a thing, the state as of a date, its contradictions and the history of one
 * attribute (state.js), and open needs as commitments with the sign flipped (requests.js openNeeds).
 *
 * Nothing here is wired on its own. The integrator adds two calls:
 *
 *   server.js, in createServer, right after the about_thing tool:
 *     registerQueryTools(server, { identity, need, readScope, role });
 *   routes.js, after the request routes:
 *     registerQueryRoutes(app);
 *
 * Each tool is scoped like about_thing: listed only when the graph is divided into positions, read
 * capability required, and a worker thread reads what its entry's people see unless beyond: true
 * (readScope). Each route resolves the bearer token like the other /api routes and answers 401, 409
 * (not scoped) or 403 (no read capability) the same way.
 */
import { z } from "zod";
import { positionMap, requireCap, resolveIdentity, SCOPED, scopeOf } from "./scope.js";
import { conflicts, currentState, history, stateAsOf } from "./state.js";
import { openNeeds } from "./requests.js";

const text = (r) => ({ content: [{ type: "text", text: JSON.stringify(r) }] });

/** the MCP tools, into the server createServer builds for one identity */
export function registerQueryTools(server, { identity, need, readScope, role }) {
  if (!SCOPED) return;
  const beyond = role === "worker" ? { beyond: z.boolean().optional() } : {};
  const workerNote = role === "worker" ? " Like about_thing, it shows what your entry's people see; beyond: true shows everything, and then what you write may be held for an admin." : "";
  const subject = z.string().min(1).max(200);

  server.tool(
    "current_state",
    `What holds now about one thing (a person, customer, machine, order, job), by name or record key
(mssql:dbo_Job:4471): its latest claim per attribute (stage, pay_rate, due_date, ...), each with the
section it rests on. State is what the recorded claims say, not a reading of the notes: use it before
search_graph for "what is X's ... now" questions, and search_graph for everything else. A state
with no end date holds until the next claim on the same attribute.${workerNote}`,
    { subject, ...beyond },
    async (args) => {
      need("read");
      return text(await currentState(args.subject, { scope: await readScope(args), identity }));
    },
  );

  server.tool(
    "state_as_of",
    `The states that held about one thing at a date (ISO: 2026-12-01, or with a time): the claims in
force then, per attribute. For "what was X's ... in November" and "what will hold from December 1".${workerNote}`,
    { subject, as_of: z.string().min(4).max(40), ...beyond },
    async (args) => {
      need("read");
      return text(await stateAsOf(args.subject, args.as_of, { scope: await readScope(args), identity }));
    },
  );

  server.tool(
    "conflicts",
    `Contradictions about one thing: two claims on one attribute whose intervals overlap with
different values (two pay rates from the same day, two rack contents), each with both claims and
their sections. What a later claim supersedes is not a contradiction. For a person or a worker to
settle; nothing here settles it.${workerNote}`,
    { subject, ...beyond },
    async (args) => {
      need("read");
      return text(await conflicts(args.subject, { scope: await readScope(args), identity }));
    },
  );

  server.tool(
    "state_history",
    `Every claim on one attribute of one thing, oldest first, with the intervals as they closed one
another: how the state got to where it is.${workerNote}`,
    { subject, attribute: z.string().min(1).max(60), ...beyond },
    async (args) => {
      need("read");
      return text(await history(args.subject, args.attribute, { scope: await readScope(args), identity }));
    },
  );

  if (!role) server.tool(
    "open_needs",
    `Open questions you can see, each as a commitment with the sign flipped (owed to the asker, by
nobody yet), in the shape of a commitment claim so they list beside open commitments.`,
    {},
    async () => {
      need("read");
      return text({ needs: await openNeeds(scopeOf(identity)) });
    },
  );
}

/** the caller behind an /api/state request, or null after answering why not */
function stateScope(req, res) {
  const identity = resolveIdentity(req.headers.authorization);
  if (!identity) {
    res.status(401).json({ error: "unauthenticated" });
    return null;
  }
  if (!SCOPED || !positionMap) {
    res.status(409).json({ error: "the knowledge graph isn't divided into positions" });
    return null;
  }
  try {
    requireCap(identity.caps, "read");
  } catch (e) {
    res.status(403).json({ error: String(e.message ?? e) });
    return null;
  }
  return { identity, scope: scopeOf(identity) };
}
const answer = (res, p) => p.then((r) => res.json(r), (e) => res.status(400).json({ error: String(e instanceof Error ? e.message : e).slice(0, 300) }));
const q = (req, name) => String(req.query?.[name] ?? "").trim().slice(0, 200);

/** the /api/state/* routes, into the express app routes.js builds */
export function registerQueryRoutes(app) {
  app.get("/api/state/current", (req, res) => {
    const ctx = stateScope(req, res);
    if (ctx) answer(res, currentState(q(req, "subject"), ctx));
  });
  app.get("/api/state/as-of", (req, res) => {
    const ctx = stateScope(req, res);
    if (ctx) answer(res, stateAsOf(q(req, "subject"), q(req, "date") || q(req, "as_of"), ctx));
  });
  app.get("/api/state/conflicts", (req, res) => {
    const ctx = stateScope(req, res);
    if (ctx) answer(res, conflicts(q(req, "subject"), ctx));
  });
  app.get("/api/state/history", (req, res) => {
    const ctx = stateScope(req, res);
    if (ctx) answer(res, history(q(req, "subject"), q(req, "attribute"), ctx));
  });
  app.get("/api/state/needs", (req, res) => {
    const ctx = stateScope(req, res);
    if (ctx) answer(res, openNeeds(ctx.scope).then((needs) => ({ needs })));
  });
}
