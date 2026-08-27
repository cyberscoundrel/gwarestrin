# DAB workaround: tables/views without primary keys (deferred)

Status: **designed, not implemented** (2026-08-25). Implement when PK-less
objects are needed by agents. Currently these objects are *excluded* from
`autoentities` and invisible to agents.

## Background

SQL MCP Server (DAB) refuses to expose database objects without a primary key —
engine startup fails with `Primary key not configured on the given database
object`. Rationale: the DML tools promise deterministic single-row targeting
(update/delete), stable pagination (unique ORDER BY tiebreaker), relationship
joins, and identity-keyed caching. A PK constraint is the database-enforced
guarantee of row identity; without it DAB fails closed.

**Escape hatch (DAB 2.0):** `entities.<name>.fields[]` with `primary-key: true`
designates key columns *without* any database constraint (works for
`type: table` and `type: view`; supersedes deprecated `source.key-fields`).
The designation is trusted, not enforced — so wrong designations make
update/delete hit multiple rows. **Therefore: designated-key entities must be
`read`-only** (`read_records` / `aggregate_records` work fine; writes stay
blocked until someone deliberately opts in per entity).

## Implementation sketch

In the host-side generator (the python that writes `~/gwarestrin/dab-config/`),
add an explicit `entities` block to the sandbox parent config. Keep the current
`autoentities` exclusions as-is (explicit entities stand alone and also take
precedence over same-name autoentity matches).

Entity naming follows the existing `{schema}_{object}` convention. Permissions
for all of the below: `[{ "role": "anonymous", "actions": ["read"] }]`.

### PK-less tables (`sandbox`) — proposed designated keys

| Object | Columns (observed) | Designate as key |
|---|---|---|
| `dbo.IdentityLog` | Spid, TableName, KeyValue | `[TableName, KeyValue]` |
| `dbo.Lookup_Type` | Lookup_Type, Name, Param_Sequence | `[Lookup_Type, Name]` |
| `dbo.Raw_Stock_Old` | Raw_Stock, Type, Shape, Length, … | `[Raw_Stock, Type]` |
| `dbo.tblJB_Keys` | tblJB_Keys, K_Table, K_KeyValue | `[tblJB_Keys]` |
| `dbo.tblJB_PrimKeys` | tblJB_PrimKeys, Table_Name, Column_Name, Sequence | `[tblJB_PrimKeys]` |

### Views (`sandbox`) — `type: "view"`, proposed designated keys

| Object | Key | Object | Key |
|---|---|---|---|
| `vw_addl_charges_job` | `[Job, AddlCharge]` | `vw_quotes` | `[quote, Line]` |
| `vw_addl_charges_sodetail` | `[SO_Detail, AddlCharge]` | `vw_quotes_sum` | `[customer]` |
| `vw_EmployeeSearchResult` | `[Employee]` | `vw_ShapeSearchResult` | `[ObjectID]` |
| `vw_JobOperationResult` | `[JobOperationId]` | `vw_shipments` | `[JobSO, Part]` |
| `vw_JobSearchViewDeliverySearchResult` | `[ObjectID]` | `vw_unscheduleddeliveries` | `[JobSO, Part]` |
| `vw_JobSearchViewResult` | `[JobObjectOID]` | `vw_UserCodeSearchResult` | `[ObjectID]` |
| `vw_openorders` | `[JobSO, Part]` | `vw_WCSearchResult` | `[ObjectID]` |
| `vw_OperationResult` | `[ObjectID]` | `vw_WCShiftsSearchResult` | `[Shift_Name, Work_Center]` |
| `vw_QuoteOperationResult` | `[QuoteOperationId]` | | |

### Example entity shape

```json
"dbo_vw_quotes": {
  "source": { "type": "view", "object": "dbo.vw_quotes" },
  "fields": [
    { "name": "quote", "primary-key": true },
    { "name": "Line", "primary-key": true }
  ],
  "permissions": [{ "role": "anonymous", "actions": ["read"] }]
}
```

## Verification when implementing

1. `dab validate --config /etc/gwarestrin/dab/dab-config.json` → valid
2. stdio smoke (see RUNBOOK §3a) → engine starts (no PK error), 7 DML tools
3. `describe_entities` count rises 136 → ~158; `dbo_IdentityLog`,
   `dbo_vw_quotes` present
4. `read_records` against `dbo_vw_quotes` limit 1 via a live agent

## Widening to writes later

Per entity, replace `"read"` with `["read","create","update","delete"]` — only
after confirming the designated key is truly unique in practice
(`SELECT key, COUNT(*) … GROUP BY key HAVING COUNT(*) > 1` returns zero).
