// gwarestrin homelab seed graph — ArcadeDB (openCypher via graph-rag):
//   node scripts/seed-arcadedb.mjs [graph-rag-host]
// Idempotent on natural keys (upsert clears + recreates; run on empty db).
// Types extend Entity so facet vector indexes on Entity cover every node.

CREATE VERTEX TYPE Machine EXTENDS Entity;
CREATE VERTEX TYPE Network EXTENDS Entity;
CREATE VERTEX TYPE Service EXTENDS Entity;
CREATE VERTEX TYPE Database EXTENDS Entity;
CREATE VERTEX TYPE Agent EXTENDS Entity;

CREATE (thinkcentre:Machine {name: "thinkcentre"})
  SET thinkcentre.ip = "100.96.0.10", thinkcentre.os = "Ubuntu 24.04",
      thinkcentre.role = "homelab docker host", thinkcentre.cpu = "8C", thinkcentre.ram_gb = 14
CREATE (inference:Machine {name: "inference-box"})
  SET inference.ip = "100.96.0.9", inference.role = "llm inference (llama.cpp)",
      inference.model = "Qwen3.8-27B-UD-Q8_K_XL.gguf", inference.n_ctx = 262144
CREATE (tailnet:Network {name: "tailnet"})
  SET tailnet.cidr = "100.64.0.0/10", tailnet.kind = "tailscale mesh"
CREATE (lan:Network {name: "wifi-lan"})
  SET lan.cidr = "10.0.0.0/24", lan.kind = "local wired"

CREATE (gwarestrin:Service {name: "gwarestrin"})
  SET gwarestrin.port = 3000, gwarestrin.kind = "docker container",
      gwarestrin.purpose = "multi-agent web console (pi agents in gondolin microvms)"
CREATE (dab:Service {name: "dab"})
  SET dab.kind = "docker sidecar", dab.purpose = "Microsoft SQL MCP Server (Data API builder)",
      dab.mcp_url = "http://dab:5000/mcp"
CREATE (litellm:Service {name: "litellm"})
  SET litellm.kind = "docker sidecar", litellm.purpose = "OpenAI-compatible LLM gateway (local llama.cpp + OpenRouter)",
      litellm.base_url = "http://litellm:4000/v1"
CREATE (graphrag:Service {name: "graph-rag"})
  SET graphrag.kind = "docker sidecar", graphrag.purpose = "facet-indexed vector retrieval + graph MCP (search_graph/upsert_entities/query_graph/execute_graph)",
      graphrag.mcp_url = "http://graph-rag:8000/mcp"
CREATE (arcadedb:Database {name: "arcadedb"})
  SET arcadedb.engine = "arcadedb 26.5.1 (Apache-2.0)", arcadedb.http = 2480,
      arcadedb.models = "graph + document + vector + full-text"
CREATE (mssql:Database {name: "mssql"})
  SET mssql.engine = "sql server", mssql.port = 1433
CREATE (sandbox:Database {name: "sandbox"})
  SET sandbox.engine = "mssql", sandbox.note = "legacy shop management db (JobBOSS-style)"
CREATE (integrations:Database {name: "INTEGRATIONS"})
  SET integrations.engine = "mssql", integrations.note = "MT_* migration/integration tables"
CREATE (tcminventory:Database {name: "tcminventory"})
  SET tcminventory.engine = "mssql"
CREATE (stockcount:Database {name: "stockcount"})
  SET stockcount.engine = "mssql"

CREATE (kjlij:Agent {name: "kjlij"})
CREATE (iuhuuhkku:Agent {name: "iuhuuhkku"})

CREATE (thinkcentre)-[:IN_NETWORK]->(tailnet)
CREATE (inference)-[:IN_NETWORK]->(tailnet)
CREATE (thinkcentre)-[:IN_NETWORK]->(lan)
CREATE (gwarestrin)-[:RUNS_ON]->(thinkcentre)
CREATE (dab)-[:RUNS_ON]->(thinkcentre)
CREATE (litellm)-[:RUNS_ON]->(thinkcentre)
CREATE (arcadedb)-[:RUNS_ON]->(thinkcentre)
CREATE (mssql)-[:RUNS_ON]->(thinkcentre)
CREATE (gwarestrin)-[:USES_MODEL]->(inference)
CREATE (gwarestrin)-[:USES_GATEWAY]->(litellm)
CREATE (gwarestrin)-[:MCP_LINK]->(dab)
CREATE (gwarestrin)-[:MCP_LINK]->(graphrag)
CREATE (dab)-[:QUERIES]->(mssql)
CREATE (graphrag)-[:QUERIES]->(arcadedb)
CREATE (mssql)-[:HOSTS_DB]->(sandbox)
CREATE (mssql)-[:HOSTS_DB]->(integrations)
CREATE (mssql)-[:HOSTS_DB]->(tcminventory)
CREATE (mssql)-[:HOSTS_DB]->(stockcount)
CREATE (kjlij)-[:RUNS_IN]->(gwarestrin)
CREATE (iuhuuhkku)-[:RUNS_IN]->(gwarestrin)
