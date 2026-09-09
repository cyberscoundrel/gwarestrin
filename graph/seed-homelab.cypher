// gwarestrin homelab seed graph — ArcadeDB (openCypher via graph-rag):
//   node scripts/seed-arcadedb.mjs [graph-rag-host]
// Idempotent: MERGE on natural keys. Types extend Entity so the facet vector
// indexes on Entity cover every node.

CREATE VERTEX TYPE Machine EXTENDS Entity;
CREATE VERTEX TYPE Network EXTENDS Entity;
CREATE VERTEX TYPE Service EXTENDS Entity;
CREATE VERTEX TYPE Database EXTENDS Entity;
CREATE VERTEX TYPE Agent EXTENDS Entity;

MERGE (thinkcentre:Machine {name: 'thinkcentre'})
  SET thinkcentre.ip = '100.96.0.10', thinkcentre.os = 'Ubuntu 24.04',
      thinkcentre.role = 'homelab docker host', thinkcentre.cpu = '8C', thinkcentre.ram_gb = 14
MERGE (inference:Machine {name: 'inference-box'})
  SET inference.ip = '100.96.0.9', inference.role = 'llm inference (llama.cpp)',
      inference.model = 'Qwen3.8-27B-UD-Q8_K_XL.gguf', inference.n_ctx = 262144
MERGE (tailnet:Network {name: 'tailnet'})
  SET tailnet.cidr = '100.64.0.0/10', tailnet.kind = 'tailscale mesh'
MERGE (lan:Network {name: 'wifi-lan'})
  SET lan.cidr = '10.0.0.0/24', lan.kind = 'local wired'

MERGE (gwarestrin:Service {name: 'gwarestrin'})
  SET gwarestrin.port = 3000, gwarestrin.kind = 'docker container',
      gwarestrin.purpose = 'multi-agent web console (pi agents in gondolin microvms)'
MERGE (dab:Service {name: 'dab'})
  SET dab.kind = 'docker sidecar', dab.purpose = 'Microsoft SQL MCP Server (Data API builder)',
      dab.mcp_url = 'http://dab:5000/mcp'
MERGE (litellm:Service {name: 'litellm'})
  SET litellm.kind = 'docker sidecar', litellm.purpose = 'OpenAI-compatible LLM gateway (local llama.cpp + OpenRouter)',
      litellm.base_url = 'http://litellm:4000/v1'
MERGE (graphrag:Service {name: 'graph-rag'})
  SET graphrag.kind = 'docker sidecar', graphrag.purpose = 'facet-indexed vector retrieval + graph MCP (search_graph/upsert_entities/query_graph/execute_graph)',
      graphrag.mcp_url = 'http://graph-rag:8000/mcp'
MERGE (arcadedb:Database {name: 'arcadedb'})
  SET arcadedb.engine = 'arcadedb 26.5.1 (Apache-2.0)', arcadedb.http = 2480,
      arcadedb.models = 'graph + document + vector + full-text'
MERGE (mssql:Database {name: 'mssql'})
  SET mssql.engine = 'sql server', mssql.port = 1433
MERGE (sandbox:Database {name: 'sandbox'})
  SET sandbox.engine = 'mssql', sandbox.note = 'legacy shop management db (JobBOSS-style)'
MERGE (integrations:Database {name: 'INTEGRATIONS'})
  SET integrations.engine = 'mssql', integrations.note = 'MT_* migration/integration tables'
MERGE (tcminventory:Database {name: 'tcminventory'})
  SET tcminventory.engine = 'mssql'
MERGE (stockcount:Database {name: 'stockcount'})
  SET stockcount.engine = 'mssql'

MERGE (kjlij:Agent {name: 'kjlij'})
MERGE (iuhuuhkku:Agent {name: 'iuhuuhkku'})

MERGE (a:Machine {name: 'thinkcentre'})
MERGE (b:Network {name: 'tailnet'})
MERGE (a)-[:IN_NETWORK]->(b)
MERGE (a:Machine {name: 'inference-box'})
MERGE (b:Network {name: 'tailnet'})
MERGE (a)-[:IN_NETWORK]->(b)
MERGE (a:Machine {name: 'thinkcentre'})
MERGE (b:Network {name: 'wifi-lan'})
MERGE (a)-[:IN_NETWORK]->(b)
MERGE (a:Service {name: 'gwarestrin'})
MERGE (b:Machine {name: 'thinkcentre'})
MERGE (a)-[:RUNS_ON]->(b)
MERGE (a:Service {name: 'dab'})
MERGE (b:Machine {name: 'thinkcentre'})
MERGE (a)-[:RUNS_ON]->(b)
MERGE (a:Service {name: 'litellm'})
MERGE (b:Machine {name: 'thinkcentre'})
MERGE (a)-[:RUNS_ON]->(b)
MERGE (a:Database {name: 'arcadedb'})
MERGE (b:Machine {name: 'thinkcentre'})
MERGE (a)-[:RUNS_ON]->(b)
MERGE (a:Database {name: 'mssql'})
MERGE (b:Machine {name: 'thinkcentre'})
MERGE (a)-[:RUNS_ON]->(b)
MERGE (a:Service {name: 'gwarestrin'})
MERGE (b:Machine {name: 'inference-box'})
MERGE (a)-[:USES_MODEL]->(b)
MERGE (a:Service {name: 'gwarestrin'})
MERGE (b:Service {name: 'litellm'})
MERGE (a)-[:USES_GATEWAY]->(b)
MERGE (a:Service {name: 'gwarestrin'})
MERGE (b:Service {name: 'dab'})
MERGE (a)-[:MCP_LINK]->(b)
MERGE (a:Service {name: 'gwarestrin'})
MERGE (b:Service {name: 'graph-rag'})
MERGE (a)-[:MCP_LINK]->(b)
MERGE (a:Service {name: 'dab'})
MERGE (b:Database {name: 'mssql'})
MERGE (a)-[:QUERIES]->(b)
MERGE (a:Service {name: 'graph-rag'})
MERGE (b:Database {name: 'arcadedb'})
MERGE (a)-[:QUERIES]->(b)
MERGE (a:Database {name: 'mssql'})
MERGE (b:Database {name: 'sandbox'})
MERGE (a)-[:HOSTS_DB]->(b)
MERGE (a:Database {name: 'mssql'})
MERGE (b:Database {name: 'INTEGRATIONS'})
MERGE (a)-[:HOSTS_DB]->(b)
MERGE (a:Database {name: 'mssql'})
MERGE (b:Database {name: 'tcminventory'})
MERGE (a)-[:HOSTS_DB]->(b)
MERGE (a:Database {name: 'mssql'})
MERGE (b:Database {name: 'stockcount'})
MERGE (a)-[:HOSTS_DB]->(b)
MERGE (a:Agent {name: 'kjlij'})
MERGE (b:Service {name: 'gwarestrin'})
MERGE (a)-[:RUNS_IN]->(b)
MERGE (a:Agent {name: 'iuhuuhkku'})
MERGE (b:Service {name: 'gwarestrin'})
MERGE (a)-[:RUNS_IN]->(b)
