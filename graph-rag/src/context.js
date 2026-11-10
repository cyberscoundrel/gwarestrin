/**
 * Configuration (environment) and the process-wide handles every area shares: the log, the dependency
 * health and the background loops. No graph access here.
 */
import { createHealth, createLoops } from "./health.js";

export const {
  ARCADEDB_URL = "http://arcadedb:2480",
  ARCADEDB_DB = "gwarestrin",
  ARCADEDB_USER = "root",
  ARCADEDB_PASSWORD = "",
  LITELLM_BASE_URL = "http://litellm:4000/v1",
  LITELLM_API_KEY = "",
  EMBED_MODEL = "embed-minilm",
  EMBED_DIM = "384",
  SWEEP_INTERVAL_MS = "600000",
  PORT = "8000",
  TOKEN_MAP_PATH = "",
  GRAPH_RAG_OPEN_MODE = "",
  POSITION_MAP_PATH = "",
  // semantic grading of new writes against the position tree (empty = off)
  GRADER_MODEL = "",
  GRADER_TIMEOUT_MS = "30000",
  EMBED_TIMEOUT_MS = "30000",
  // where pruned entries go before deletion; "discard" keeps nothing (see prune.js)
  PRUNE_SINK = "discard",
  // where whole documents live (outside ArcadeDB; see docstore.js)
  DOC_STORE = "fs:/app/documents",
  // the model that extracts facts from documents (when an ingest asks for it); default: the grader's
  EXTRACT_MODEL = "",
  // the graph worker (finds the things statements are about); its model and instructions
  // normally come from the admin's Graph worker profile; these are fallbacks and limits
  WORKER_MODEL = "",
  // a Jev-style decision model (TypeSafe's Jev through OpenRouter, or a compatible one) for the typed check per section (R4)
  DECISION_URL = "https://openrouter.ai/api/alpha/decisions",
  DECISION_API_KEY = "",
  DECISION_MODEL = "~typesafe/jev-latest",
  WORKER_TIMEOUT_MS = "120000",
  WORKER_DAILY_CALLS = "300",
  // policy defaults (MAX_GRANT_DAYS, DEFAULT_SHARE_DAYS, STANDING_GRANTS,
  // PEOPLE_SHARE_DIRECTLY, GRADING_ENABLED, GRADING_CONFIDENCE,
  // DERIVED_WINDOW_HOURS) are read by policy.js
} = process.env;

export const log = { warn: (...a) => console.warn("[graph-rag]", ...a), info: (...a) => console.log("[graph-rag]", ...a) };
// the model routes and the decision API (an outage pauses what needs them), and the background loops (a failing one shows in the status)
export const health = createHealth();
export const loops = createLoops(log);
