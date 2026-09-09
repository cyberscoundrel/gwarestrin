// gwarestrin homelab seed graph — ArcadeDB (openCypher via graph-rag):
//   node scripts/seed-arcadedb.mjs [graph-rag-host]
// One statement per line, semicolon-terminated. MERGE = idempotent.
// Types extend Entity so the facet vector indexes on Entity cover every node.

CREATE VERTEX TYPE Machine EXTENDS Entity;
CREATE VERTEX TYPE Network EXTENDS Entity;
CREATE VERTEX TYPE Service EXTENDS Entity;
CREATE VERTEX TYPE Database EXTENDS Entity;
CREATE VERTEX TYPE Agent EXTENDS Entity;
MERGE (m:Machine {name: 'thinkcentre'}) SET m.ip = '100.96.0.10', m.os = 'Ubuntu 24.04', m.role = 'homelab docker host', m.cpu = '8C', m.ram_gb = 14;
MERGE (m:Machine {name: 'inference-box'}) SET m.ip = '100.96.0.9', m.role = 'llm inference (llama.cpp)', m.model = 'Qwen3.8-27B-UD-Q8_K_XL.gguf', m.n_ctx = 262144;
MERGE (m:Network {name: 'tailnet'}) SET m.cidr = '100.64.0.0/10', m.kind = 'tailscale mesh';
MERGE (m:Network {name: 'wifi-lan'}) SET m.cidr = '10.0.0.0/24', m.kind = 'local wired';
MERGE (s:Service {name: 'gwarestrin'}) SET s.port = 3000, s.kind = 'docker container', s.purpose = 'multi-agent web console (pi agents in gondolin microvms)';
MERGE (s:Service {name: 'dab'}) SET s.kind = 'docker sidecar', s.purpose = 'Microsoft SQL MCP Server (Data API builder)', s.mcp_url = 'http://dab:5000/mcp';
MERGE (s:Service {name: 'litellm'}) SET s.kind = 'docker sidecar', s.purpose = 'OpenAI-compatible LLM gateway (local llama.cpp + OpenRouter)', s.base_url = 'http://litellm:4000/v1';
MERGE (s:Service {name: 'graph-rag'}) SET s.kind = 'docker sidecar', s.purpose = 'facet-indexed vector retrieval + graph MCP (search_graph/upsert_entities/query_graph/execute_graph)', s.mcp_url = 'http://graph-rag:8000/mcp';
MERGE (d:Database {name: 'arcadedb'}) SET d.engine = 'arcadedb 26.5.1 (Apache-2.0)', d.http = 2480, d.models = 'graph + document + vector + full-text';
MERGE (d:Database {name: 'mssql'}) SET d.engine = 'sql server', d.port = 1433;
MERGE (d:Database {name: 'sandbox'}) SET d.engine = 'mssql', d.note = 'legacy shop management db (JobBOSS-style)';
MERGE (d:Database {name: 'INTEGRATIONS'}) SET d.engine = 'mssql', d.note = 'MT_* migration/integration tables';
MERGE (d:Database {name: 'tcminventory'}) SET d.engine = 'mssql';
MERGE (d:Database {name: 'stockcount'}) SET d.engine = 'mssql';
MERGE (a:Agent {name: 'kjlij'});
MERGE (a:Agent {name: 'iuhuuhkku'});
MERGE (a:Machine {name: 'thinkcentre'}) MERGE (b:Network {name: 'tailnet'}) MERGE (a)-[:IN_NETWORK]->(b);
MERGE (a:Machine {name: 'inference-box'}) MERGE (b:Network {name: 'tailnet'}) MERGE (a)-[:IN_NETWORK]->(b);
MERGE (a:Machine {name: 'thinkcentre'}) MERGE (b:Network {name: 'wifi-lan'}) MERGE (a)-[:IN_NETWORK]->(b);
MERGE (a:Service {name: 'gwarestrin'}) MERGE (b:Machine {name: 'thinkcentre'}) MERGE (a)-[:RUNS_ON]->(b);
MERGE (a:Service {name: 'dab'}) MERGE (b:Machine {name: 'thinkcentre'}) MERGE (a)-[:RUNS_ON]->(b);
MERGE (a:Service {name: 'litellm'}) MERGE (b:Machine {name: 'thinkcentre'}) MERGE (a)-[:RUNS_ON]->(b);
MERGE (a:Database {name: 'arcadedb'}) MERGE (b:Machine {name: 'thinkcentre'}) MERGE (a)-[:RUNS_ON]->(b);
MERGE (a:Database {name: 'mssql'}) MERGE (b:Machine {name: 'thinkcentre'}) MERGE (a)-[:RUNS_ON]->(b);
MERGE (a:Service {name: 'gwarestrin'}) MERGE (b:Machine {name: 'inference-box'}) MERGE (a)-[:USES_MODEL]->(b);
MERGE (a:Service {name: 'gwarestrin'}) MERGE (b:Service {name: 'litellm'}) MERGE (a)-[:USES_GATEWAY]->(b);
MERGE (a:Service {name: 'gwarestrin'}) MERGE (b:Service {name: 'dab'}) MERGE (a)-[:MCP_LINK]->(b);
MERGE (a:Service {name: 'gwarestrin'}) MERGE (b:Service {name: 'graph-rag'}) MERGE (a)-[:MCP_LINK]->(b);
MERGE (a:Service {name: 'dab'}) MERGE (b:Database {name: 'mssql'}) MERGE (a)-[:QUERIES]->(b);
MERGE (a:Service {name: 'graph-rag'}) MERGE (b:Database {name: 'arcadedb'}) MERGE (a)-[:QUERIES]->(b);
MERGE (a:Database {name: 'mssql'}) MERGE (b:Database {name: 'sandbox'}) MERGE (a)-[:HOSTS_DB]->(b);
MERGE (a:Database {name: 'mssql'}) MERGE (b:Database {name: 'INTEGRATIONS'}) MERGE (a)-[:HOSTS_DB]->(b);
MERGE (a:Database {name: 'mssql'}) MERGE (b:Database {name: 'tcminventory'}) MERGE (a)-[:HOSTS_DB]->(b);
MERGE (a:Database {name: 'mssql'}) MERGE (b:Database {name: 'stockcount'}) MERGE (a)-[:HOSTS_DB]->(b);
MERGE (a:Agent {name: 'kjlij'}) MERGE (b:Service {name: 'gwarestrin'}) MERGE (a)-[:RUNS_IN]->(b);
MERGE (a:Agent {name: 'iuhuuhkku'}) MERGE (b:Service {name: 'gwarestrin'}) MERGE (a)-[:RUNS_IN]->(b);
