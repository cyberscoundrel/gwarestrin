// Re-homing (tightening.js, R6): when a class map entry tightens, sections related to instances of that class
// move to the stricter home, and the instance is seen from where its sections now are. Loosening moves nothing.
// The class, the instance and the edges are written by hand here (the classes and filing streams make them later).
const q = (s) => String(s ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");

export default [
  {
    name: "a class map entry that tightens re-homes the sections about its instances, and the instance follows; loosening moves nothing",
    run: async (ctx) => {
      const { POS, check, tool, sql, until, api, randomUUID } = ctx;
      const id = randomUUID().slice(0, 8);
      const key = `e2e_rh_${id}`;
      const exec = async (command) => {
        const r = await tool("admin", "execute_graph", { language: "sql", command });
        check(!r.error, `${command.slice(0, 80)}: ${JSON.stringify(r).slice(0, 200)}`);
      };
      const one = async (where) => (await sql(`SELECT @rid AS rid, _home, _homes FROM Entity WHERE ${where}`))[0];
      await exec(`CREATE VERTEX Entity SET name = 'e2e-rh class ${id}', _kind = 'class', _class_name = 'e2e rh ${id}', _class_key = '${key}', _home = '${POS.ops}', _status = 'active'`);
      await exec(`CREATE VERTEX Entity SET name = 'e2e-rh press ${id}', label = 'e2e-rh press ${id}', _kind = 'thing', _home = '${POS.org}', _homes = ['${POS.floor}']`);
      await exec(`CREATE VERTEX Entity SET name = 'e2e-rh section ${id}', _kind = 'section', _home = '${POS.floor}', _origin = '${POS.floor}', text_identity = '${q(`Press ${id} is down for its bearings.`)}'`);
      const cls = await one(`_kind = 'class' AND _class_key = '${key}'`);
      const inst = await one(`_kind = 'thing' AND name = 'e2e-rh press ${id}'`);
      const sec = await one(`_kind = 'section' AND name = 'e2e-rh section ${id}'`);
      check(cls && inst && sec, "class, instance and section written");
      await exec(`CREATE EDGE INSTANCE_OF FROM ${inst.rid} TO ${cls.rid} SET added_by = 'e2e', at = '${new Date().toISOString()}'`);
      await exec(`CREATE EDGE ABOUT FROM ${sec.rid} TO ${inst.rid} SET role = 'mentions'`);

      const before = (await api("/api/policy")).policy?.authorityMap ?? { classes: {}, attributes: {} };
      const put = (authority) => api("/api/policy", { method: "PUT", body: JSON.stringify({ authorityMap: { ...before, classes: { ...(before.classes ?? {}), [key]: { authority } } } }) });
      const done = async () => Number((await sql("SELECT count(*) AS n FROM PolicyChange WHERE rehome_status = 'pending'"))[0]?.n ?? 0) === 0;
      try {
        // an entry at the floor: where the section already is, so it stays
        const first = await put(POS.floor);
        check(first.policy?.authorityMap?.classes?.[key]?.authority === POS.floor, `the entry is set: ${JSON.stringify(first).slice(0, 200)}`);
        await until("the first change worked through", done, 60_000);
        check((await one(`@rid = ${sec.rid}`))._home === POS.floor, "the section stays where the entry already is");
        // tightened to Operations: the section rises, the instance is seen from there and no longer from the floor
        await put(POS.ops);
        await until("the section re-homed", async () => (await one(`@rid = ${sec.rid}`))?._home === POS.ops, 60_000);
        const after = await one(`@rid = ${inst.rid}`);
        check((after._homes ?? []).includes(POS.ops) && !(after._homes ?? []).includes(POS.floor), `the instance follows its section: ${JSON.stringify(after._homes)}`);
        const grade = (await sql(`SELECT _grade FROM ${sec.rid}`))[0]?._grade ?? "";
        check(grade.includes(key) && /raised to Operations/.test(grade), `it says why: ${grade}`);
        // loosened back to the floor: nothing moves down
        await put(POS.floor);
        await until("the loosening worked through", done, 60_000);
        check((await one(`@rid = ${sec.rid}`))._home === POS.ops, "loosening moves nothing");
      } finally {
        await api("/api/policy", { method: "PUT", body: JSON.stringify({ authorityMap: before }) });
      }
    },
  },
];
