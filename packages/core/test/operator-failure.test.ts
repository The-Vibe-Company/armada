import { expect, test } from "bun:test";
import { failureDiagnostic } from "../src/operator-failure.ts";

function postgresError(message: string, sqlState: string): Error {
  // Bun's PostgresError keeps the generic driver code in `code` and the SQLSTATE in `errno`.
  return Object.assign(new Error(message), {
    name: "PostgresError",
    code: "ERR_POSTGRES_SERVER_ERROR",
    errno: sqlState,
  });
}

test.each([
  ['relation "public.skill_defaults" does not exist', "42P01"],
  ['column "correlation_id" of relation "runtime_commands" does not exist', "42703"],
  ["column runtime_commands.correlation_id does not exist", "42703"],
  ["function public.reserve_golden_backend_slot(uuid, text) does not exist", "42883"],
  ["permission denied for table runtime_commands", "42501"],
  ["there is no unique or exclusion constraint matching the ON CONFLICT specification", "42P10"],
])("schema drift keeps identifier-only database messages and their SQLSTATE: %s", (message, state) => {
  expect(failureDiagnostic(new Error("launch failed", { cause: postgresError(message, state) })).message).toBe(
    `${message} (SQLSTATE ${state})`,
  );
});

test("other database messages keep only their SQLSTATE", () => {
  const error = postgresError('duplicate key value violates unique constraint "x" Key (email)=(a@b.c)', "23505");
  expect(failureDiagnostic(error)).toMatchObject({ errorClass: "PostgresError", message: "SQLSTATE 23505" });
});

test.each([
  'relation "pw=hunter two" does not exist',
  "function f(hunter') does not exist",
  "permission denied for table runtime_commands; hunter",
])("free text shaped like schema drift stays withheld: %s", (message) => {
  expect(failureDiagnostic(new Error(message)).message).toBe("Exception message withheld");
});
