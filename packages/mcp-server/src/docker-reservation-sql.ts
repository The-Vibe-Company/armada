import type { Sql } from "@armada/core";

// PostgreSQL identifiers only; never include messages, detail, hint, SQL or parameters.
export function reservationDatabaseDiagnostic(error: unknown) {
  const fields = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const identifier = (value: unknown) =>
    typeof value === "string" && /^[a-z_][a-z0-9_]{0,62}$/.test(value) ? value : undefined;
  const code = fields.errno ?? fields.code;
  return {
    sqlstate: typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : undefined,
    constraint: identifier(fields.constraint_name ?? fields.constraint),
    relation: identifier(fields.table_name ?? fields.table),
  };
}

/** The reservation is already inside a transaction; nested services receive this same connection. */
export function reservationSql(tx: Sql): Sql {
  return {
    async query<T>(statement: string, params?: unknown[]) {
      // Labels come only from static application SQL, not driver messages or bound values.
      const operation = /^\s*(select|insert|update|delete)\b/i.exec(statement)?.[1]?.toLowerCase() ?? "query";
      const relation = /\b(?:from|into|update)\s+(public\.[a-z_][a-z0-9_]*)\b/i.exec(statement)?.[1];
      const label = `${operation}:${relation ?? "transaction_lock"}`;
      try {
        return await tx.query<T>(statement, params);
      } catch (error) {
        console.warn("docker_reservation_statement_failed", {
          statement: label,
          ...reservationDatabaseDiagnostic(error),
        });
        throw error;
      }
    },
  };
}
