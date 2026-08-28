// gwarestrin homelab seed graph — load with:
//   curl -s -X POST -H 'content-type: application/json' \
//     --data-binary @<(python3 -c 'import json,sys; print(json.dumps({"statements":[{"statement": sys.stdin.read()}]}))' < neo4j/seed-homelab.cypher) \
//     http://localhost:7474/db/neo4j/tx/commit
// Idempotent: MERGE on natural keys.

CREATE (thinkcentre:Machine {name: "thinkcentre"})
  SET thinkcentre.ip = "100.96.0.10", thinkcentre.os = "Ubuntu 24.04",
      thinkcentre.role = "homelab docker host", thinkcentre.cpu = "8C", thinkcentre.ram_gb = 14
CREATE (inference:Machine {name: "inference-box"})
  SET inference.ip = "100.96.0.9", inference.role = "llm inference (llama.cpp)",
      inference.model = "Qwen3.8-27B-UD-Q8_K_XL.gguf", inference.n_ctx = 262144
CREATE (tailnet:Network {name: "tailnet"})
  SET tailnet.cidr = "100.64.0.0/10", tailnet.kind = "tailscale mesh"
CREATE (lan:Network {name: "wifi-lan"})
  SET lan.cidr = "10.0.0.0/24", lan.kind = "local wifi"

CREATE (gwarestrin:Service {name: "gwarestrin"})
  SET gwarestrin.port = 3000, gwarestrin.kind = "docker container",
      gwarestrin.purpose = "multi-agent web console (pi agents in gondolin microvms)"
CREATE (dab:Service {name: "dab"})
  SET dab.kind = "docker sidecar", dab.purpose = "Microsoft SQL MCP Server (Data API builder)",
      dab.mcp_url = "http://dab:5000/mcp"
CREATE (neo4jmcp:Service {name: "neo4j-mcp"})
  SET neo4jmcp.kind = "docker sidecar", neo4jmcp.purpose = "official neo4j cypher MCP server",
      neo4jmcp.mcp_url = "http://neo4j-mcp:8000/mcp/"
CREATE (neo4jdb:Database {name: "neo4j"})
  SET neo4jdb.engine = "neo4j community 2026.07", neo4jdb.bolt = 7687, neo4jdb.http = 7474
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
CREATE (neo4jmcp)-[:RUNS_ON]->(thinkcentre)
CREATE (neo4jdb)-[:RUNS_ON]->(thinkcentre)
CREATE (mssql)-[:RUNS_ON]->(thinkcentre)
CREATE (gwarestrin)-[:USES_MODEL]->(inference)
CREATE (gwarestrin)-[:MCP_LINK]->(dab)
CREATE (gwarestrin)-[:MCP_LINK]->(neo4jmcp)
CREATE (dab)-[:QUERIES]->(mssql)
CREATE (neo4jmcp)-[:QUERIES]->(neo4jdb)
CREATE (mssql)-[:HOSTS_DB]->(sandbox)
CREATE (mssql)-[:HOSTS_DB]->(integrations)
CREATE (mssql)-[:HOSTS_DB]->(tcminventory)
CREATE (mssql)-[:HOSTS_DB]->(stockcount)
CREATE (kjlij)-[:RUNS_IN]->(gwarestrin)
CREATE (iuhuuhkku)-[:RUNS_IN]->(gwarestrin)
