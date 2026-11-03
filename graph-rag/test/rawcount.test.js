import assert from "node:assert/strict";
import { test } from "node:test";
import { changedCount, changedNothing, countingCommand } from "../src/rawcount.js";

test("a Cypher MATCH … SET without RETURN is made to count what it changed", () => {
  assert.equal(countingCommand("MATCH (t) WHERE t.name = 'a' SET t.x = 1;", "cypher"), "MATCH (t) WHERE t.name = 'a' SET t.x = 1 RETURN count(*) AS changed");
  assert.equal(countingCommand("MATCH (t) DETACH DELETE t", "cypher"), "MATCH (t) DETACH DELETE t RETURN count(*) AS changed");
  // its own RETURN, a CREATE, SQL: run as written
  assert.equal(countingCommand("MATCH (t) SET t.x = 1 RETURN t.name", "cypher"), "MATCH (t) SET t.x = 1 RETURN t.name");
  assert.equal(countingCommand("CREATE (t:Entity {name: 'a'})", "cypher"), "CREATE (t:Entity {name: 'a'})");
  assert.equal(countingCommand("UPDATE Entity SET x = 1 WHERE name = 'a'", "sql"), "UPDATE Entity SET x = 1 WHERE name = 'a'");
});

test("the changed count is read where it can be told, null elsewhere", () => {
  const set = "MATCH (t) WHERE t._keys CONTAINS 'k' SET t.name = 'b'";
  assert.equal(changedCount(set, "cypher", [{ changed: 0 }]), 0);
  assert.equal(changedCount(set, "cypher", [{ changed: 2 }]), 2);
  assert.equal(changedCount("MATCH (t) SET t.x = 1 RETURN t.name", "cypher", [{ "t.name": "a" }]), null);
  assert.equal(changedCount("UPDATE Entity SET x = 1 WHERE name = 'a'", "sql", [{ count: 0 }]), 0);
  assert.equal(changedCount("DELETE FROM Entity WHERE name = 'a'", "sql", [{ count: 3 }]), 3);
  assert.equal(changedCount("CREATE PROPERTY Entity.x STRING", "sql", [{ operation: "create property" }]), null);
  assert.equal(changedCount("UPDATE Entity SET x = 1", "sql", []), null);
});

test("changing nothing says why, with the list hint for Cypher", () => {
  assert.match(changedNothing("cypher"), /matched nothing.*'value' IN n\.list/s);
  assert.doesNotMatch(changedNothing("sql"), /IN n\.list/);
});
