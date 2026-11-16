import { expect, test } from "bun:test";
import type { Sql } from "@armada/core";
import { reservationSql } from "../src/docker-reservation-sql.ts";

test("reservation SQL failures identify the statement and database object without values", async () => {
  const logs: unknown[][] = [];
  const warn = console.warn;
  console.warn = (...args) => logs.push(args);
  try {
    for (const metadata of [
      { errno: "23514", constraint: "sandboxes_docker_binding_chk", table: "sandboxes" },
      { code: "23514", constraint_name: "sandboxes_docker_binding_chk", table_name: "sandboxes" },
    ]) {
      const error = Object.assign(new Error("private_message"), metadata, {
        detail: "private_detail",
        hint: "private_hint",
      });
      const tx: Sql = {
        query: async () => {
          throw error;
        },
      };
      await expect(
        reservationSql(tx).query("insert into public.sandboxes(id) values($1)", ["private_value"]),
      ).rejects.toBe(error);
    }
    expect(logs).toEqual(
      Array.from({ length: 2 }, () => [
        "docker_reservation_statement_failed",
        {
          statement: "insert:public.sandboxes",
          sqlstate: "23514",
          constraint: "sandboxes_docker_binding_chk",
          relation: "sandboxes",
        },
      ]),
    );
    expect(JSON.stringify(logs)).not.toContain("private_");
  } finally {
    console.warn = warn;
  }
});
