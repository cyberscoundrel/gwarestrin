/** a source an agent can answer from: the knowledge graph or a tool connection */
export interface SourceInfo {
  name: string;
  /** the organization's words for what it's for (Workspaces), if written */
  description?: string | undefined;
  /** for databases: its tables and fields */
  digest?: string | null | undefined;
}
