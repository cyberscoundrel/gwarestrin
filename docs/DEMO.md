# Demo instance

The demo runs a frozen copy of the system: code at tag `demo-2026-11` (89b7a12), data from a
snapshot of the development instance taken at the freeze. It is its own compose project
(`gwdemo`), so it has its own volumes, network and containers. It stays **down** except while
rehearsing or presenting, because it shares the host's local model with the development instance.

## Bring it up

```bash
git worktree add ~/gwarestrin-demo demo-2026-11 && cd ~/gwarestrin-demo
cp ~/gwarestrin/.env .env                     # or fill in config/env.redacted from the snapshot
cp ~/gwarestrin/providers.json providers.json
cp ~/gwarestrin/arcadedb-config/root-pw arcadedb-config/root-pw
scripts/demo-restore.sh <snapshot.tgz>        # once: fills the gwdemo_* volumes and config
docker compose -p gwdemo -f docker-compose.yml -f docker-compose.demo.yml up -d --build
```

Down again (volumes stay): `docker compose -p gwdemo -f docker-compose.yml -f docker-compose.demo.yml down`.

The override only moves what would collide on one host: the app on :3100, litellm on :4101,
ArcadeDB on 127.0.0.1:2481, traefik on :8081, backend subnet 172.31.98.0/24. On a machine of
its own, drop `-f docker-compose.demo.yml` to use the normal ports.

`.env` keys that must be set: `ARCADEDB_ROOT_PASSWORD`, `LOCAL_INFERENCE_API_KEY`,
`OPENROUTER_API_KEY`, `AUTHENTIK_PG_PASSWORD`, `AUTHENTIK_SECRET_KEY`,
`AUTHENTIK_BOOTSTRAP_PASSWORD`, `AUTHENTIK_BOOTSTRAP_TOKEN`, `KVM_GID`; optional
`DECISION_MODEL`, `DECISION_URL`, `WORKER_DAILY_CALLS`, `GWARESTRIN_MAX_AGENTS`. Tenant agents
run on the OpenShell runtime (`openshell/`), which must be up as well.

A new snapshot: `scripts/demo-snapshot.sh` on the host, in the checkout of the instance to copy.
It stops the stateful services for the copy and starts them again.

## Run workers on a hosted model for a live demo

On the local model a worker turn takes minutes. For a live demo, sign in as admin, open the
**Graph worker** agent profile, and set the model for each level of work (1 quick check,
2 investigation, 3 broad) to a hosted model, e.g. an OpenRouter one. Leave the grader and embeddings local.
Clear them again afterwards. Note text then goes to that provider: use demo data only.

## Five-minute script

Sign in as **bob** (Production floor) and **alice** (Operations) in two windows, admin in a third.

1. **Save a note, see it placed.** As bob: *"Changed out the CNC 5 coolant completely."* It
   stays on the Production floor and gets linked to **CNC 5 (machine)**.
2. **A restricted one.** As alice: *"Marisol's raise to 24 an hour starts next pay period."*
   Grading puts it at **Top of the organization (admins only)** (personnel). Search for it as
   bob and as alice: neither finds it; admin does.
3. **A worker links it.** As alice: *"The Corvane samples went out by UPS this afternoon."*
   Within a worker turn it is linked to **Corvane Medical (customer)** and **UPS (supplier)**.
4. **About a customer.** As admin, `about_thing` on *Corvane Medical*: the notes about it across
   weeks (samples quoted, approved, running, shipped), each from the home it lives at.
5. **A proposal in the rail.** *Not verified for this script:* the last three batches produced
   no proposal on their own. One appears when a worker has to read beyond its note's audience;
   rehearse it before relying on it, or skip it.
6. **A question answered by a later note.** *Not verified for this script:* as bob,
   *"When does the spare Hyd-Mech blade arrive?"*, then as alice, *"The spare Hyd-Mech blade
   arrives Thursday."* Rehearse first.

## Keep out of the demo

- Notes' **relation facets** (the "related notes" text): on this tag they can name admins-only
  notes by title. Fixed on `fix/no-hidden-names`, not in the tag.
- Pay raises without a figure, and quotes for supplies without prices: grading wobbles on them.
- Order numbers and part numbers around PO 78912 / EPP-D98 (near-duplicate things), and the
  old ux-note 16/22 records.
- Notes that move between positions (one floor note once moved to Operations untraced).
- Small linking misses (a note not linked to Hyd-Mech; a bin linked to the time clock cabinet).
