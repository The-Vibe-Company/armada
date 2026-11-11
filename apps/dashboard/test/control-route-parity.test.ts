import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { operation } from "../../../packages/cli/src/operations.ts";
import { memorySessionStore } from "../../../packages/cli/src/session.ts";
import { forwardControl } from "../src/app/api/v1/[...path]/control-proxy.ts";

const cli = resolve(import.meta.dir, "../../../packages/cli/src");
const id = "11111111-1111-4111-8111-111111111111";

// Independent architecture contract: inventory the CLI, never the proxy's allow-list.
// Literal/flow-union routes are static; operations' mutable route dispatch is exercised
// with its source-declared commands/actions. Unknown route expressions fail closed.
// For a new routing pattern, extend strings() with finite CLI-derived values, or
// add a real-dispatch probe below for mutable routing. Never copy the proxy list;
// mutation-check that removing the new route makes this guard fail.
test("every CLI POST control route is admitted by the dashboard proxy", async () => {
  const files = readdirSync(cli)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => resolve(cli, name));
  const program = ts.createProgram(files, {
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    module: ts.ModuleKind.ESNext,
    strict: true,
    // Route inference needs imported CLI types, not every installed ambient package.
    types: [],
  });
  const checker = program.getTypeChecker();
  const sources = program.getSourceFiles().filter((source) => files.includes(source.fileName));
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) calls.push(node);
    ts.forEachChild(node, visit);
  };
  for (const source of sources) visit(source);
  const owner = (node: ts.Node): ts.FunctionDeclaration | undefined => {
    for (let parent = node.parent; parent; parent = parent.parent) if (ts.isFunctionDeclaration(parent)) return parent;
    return undefined;
  };
  const fail = (node: ts.Node): never => {
    throw new Error(`Unresolved CLI route: ${node.getSourceFile().fileName}: ${node.getText()}`);
  };
  const finiteType = (type: ts.Type): string[] | undefined => {
    if (type.isStringLiteral()) return [type.value];
    if (type.isUnion()) {
      const values = type.types.map(finiteType);
      if (values.every((value) => value !== undefined)) return values.flat() as string[];
    }
    const constraint = checker.getBaseConstraintOfType(type);
    return constraint && constraint !== type ? finiteType(constraint) : undefined;
  };
  const strings = (node: ts.Expression, seen = new Set<ts.Node>()): string[] => {
    if (seen.has(node)) return fail(node);
    const next = new Set(seen).add(node);
    const typed = finiteType(checker.getTypeAtLocation(node));
    if (typed) return typed;
    if (ts.isParenthesizedExpression(node)) return strings(node.expression, next);
    if (ts.isConditionalExpression(node)) return [...strings(node.whenTrue, next), ...strings(node.whenFalse, next)];
    if (ts.isTemplateExpression(node)) {
      let values = [node.head.text];
      for (const span of node.templateSpans)
        values = values.flatMap((prefix) =>
          strings(span.expression, next).map((value) => prefix + value + span.literal.text),
        );
      return values;
    }
    // Orchestrator actions turn a finite CLI union such as connections_add into
    // a path segment. Resolve the actual literals instead of copying proxy routes.
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "replace" &&
      node.arguments.length === 2 &&
      ts.isStringLiteral(node.arguments[0]!) &&
      ts.isStringLiteral(node.arguments[1]!)
    ) {
      const search = node.arguments[0]!.text;
      const replacement = node.arguments[1]!.text;
      return strings(node.expression.expression, next).map((value) => value.replace(search, replacement));
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "apiUrl")
      return strings(node.arguments[1] ?? fail(node), next);
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "encodeURIComponent"
    ) {
      // Opaque IDs may vary; action/path segments must still be finitely resolved.
      const argument = node.arguments[0];
      if (argument && /^(?:command\.id(?: \?\? "")?)$/.test(argument.getText())) return [id];
    }
    const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer)
      return strings(declaration.initializer, next);
    if (declaration && ts.isParameter(declaration)) {
      const fn = declaration.parent;
      const index = fn.parameters.indexOf(declaration);
      const arguments_ = calls
        .filter((call) => checker.getResolvedSignature(call)?.declaration === fn)
        .map((call) => call.arguments[index]);
      if (arguments_.length && arguments_.every((argument) => argument !== undefined))
        return arguments_.flatMap((argument) => strings(argument as ts.Expression, next));
    }
    // Array.includes does not narrow strings in TypeScript (golden retirement).
    // Use the CLI's actual validation array, not a second route inventory.
    if (ts.isIdentifier(node)) {
      const same = (expression: ts.Expression) =>
        checker.getSymbolAtLocation(expression) === checker.getSymbolAtLocation(node);
      const validation = calls.find(
        (call) =>
          owner(call) === owner(node) &&
          ts.isPropertyAccessExpression(call.expression) &&
          call.expression.name.text === "includes" &&
          ts.isArrayLiteralExpression(call.expression.expression) &&
          call.arguments[0] &&
          (same(call.arguments[0]) ||
            (ts.isBinaryExpression(call.arguments[0]) &&
              call.arguments[0].operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
              same(call.arguments[0].left))),
      );
      if (
        validation &&
        ts.isPropertyAccessExpression(validation.expression) &&
        ts.isArrayLiteralExpression(validation.expression.expression)
      ) {
        const handled = (condition: ts.Expression): string[] => {
          if (!ts.isBinaryExpression(condition)) return [];
          if (condition.operatorToken.kind === ts.SyntaxKind.BarBarToken)
            return [...handled(condition.left), ...handled(condition.right)];
          return condition.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
            same(condition.left) &&
            ts.isStringLiteral(condition.right)
            ? [condition.right.text]
            : [];
        };
        const excluded =
          owner(node)?.body?.statements.flatMap((statement) =>
            ts.isIfStatement(statement) &&
            statement.end < node.pos &&
            ts.isBlock(statement.thenStatement) &&
            statement.thenStatement.statements.some(ts.isReturnStatement)
              ? handled(statement.expression)
              : [],
          ) ?? [];
        return validation.expression.expression.elements
          .flatMap((element) => strings(element, next))
          .filter((value) => !excluded.includes(value));
      }
    }
    return fail(node);
  };

  const routes = new Set<string>();
  for (const call of calls) {
    const declaration = checker.getResolvedSignature(call)?.declaration;
    const control =
      declaration &&
      ts.isFunctionDeclaration(declaration) &&
      declaration.getSourceFile().fileName === resolve(cli, "control.ts");
    if (control) {
      // Mutable operation routing is covered below using the real dispatcher.
      if (owner(call)?.name?.text === "operation" && call.arguments[1]?.getText() === "route") continue;
      for (const route of strings(call.arguments[1] ?? fail(call))) routes.add(`/api/v1/${route}`);
      continue;
    }
    // Each explicit POST call supplies its URL before its RequestInit. This also
    // inventories golden build wrapper callers and unauthenticated login calls.
    const optionsIndex = call.arguments.findIndex(
      (argument) =>
        ts.isObjectLiteralExpression(argument) &&
        argument.properties.some(
          (property) =>
            ts.isPropertyAssignment(property) &&
            property.name.getText() === "method" &&
            ts.isStringLiteral(property.initializer) &&
            property.initializer.text === "POST",
        ),
    );
    if (optionsIndex < 1 || owner(call)?.name?.text === "control") continue;
    let path = call.arguments[optionsIndex - 1] ?? fail(call);
    if (ts.isNewExpression(path) && path.expression.getText() === "URL") path = path.arguments?.[0] ?? fail(path);
    // The authenticated client's fetch forwards its path argument unchanged;
    // its caller inventory above owns URLs, not the transport's local URL object.
    if (call.getSourceFile().fileName === resolve(cli, "armada-api.ts") && path.getText() === "url") continue;
    for (const route of strings(path)) routes.add(route);
  }

  const previous = process.env.ARMADA_MCP_URL;
  process.env.ARMADA_MCP_URL = "https://control.test/mcp";
  const admitted = async (path: string) => {
    expect(path.startsWith("/api/v1/")).toBe(true);
    let forwarded = false;
    const response = await forwardControl(
      new Request(`https://dashboard.test${path}`, {
        method: "POST",
        headers: { authorization: "Bearer fixture", "content-type": "application/json" },
        body: "{}",
      }),
      path.slice("/api/v1/".length).split("/"),
      Object.assign(
        async (input: string | URL | Request) => {
          expect(String(input)).toBe(`https://control.test${path}`);
          forwarded = true;
          return Response.json({ error: "fixture upstream refusal" }, { status: 503 });
        },
        { preconnect: fetch.preconnect },
      ),
    );
    expect(forwarded, `CLI POST ${path} must reach control API`).toBe(true);
    expect(response.status).toBe(503);
  };
  try {
    for (const route of routes) await admitted(route);
    const operationCall = calls.find(
      (call) =>
        checker.getResolvedSignature(call)?.declaration?.getSourceFile().fileName === resolve(cli, "operations.ts") &&
        ts.isIdentifier(call.expression) &&
        call.expression.text === "operation",
    );
    const commands = strings(operationCall?.arguments[0] ?? fail(sources[0] as ts.Node));
    const operationsSource = sources.find((source) => source.fileName === resolve(cli, "operations.ts"));
    let actions: string[] | undefined;
    const findActions = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        node.name.getText() === "actions" &&
        node.initializer &&
        ts.isArrayLiteralExpression(node.initializer)
      )
        actions = node.initializer.elements.flatMap((element) => strings(element));
      ts.forEachChild(node, findActions);
    };
    findActions(operationsSource ?? fail(sources[0] as ts.Node));
    expect(actions?.length).toBeGreaterThan(0);
    for (const command of commands) {
      if (command === "rm") continue; // DELETE is a separate contract.
      for (const action of command === "mcp" ? (actions ?? []) : [undefined]) {
        const argv =
          command === "mcp"
            ? [
                action as string,
                ...(["list", "catalog"].includes(action ?? "")
                  ? []
                  : action === "add"
                    ? ["fixture", "https://service.test"]
                    : action === "rename"
                      ? [id, "fixture"]
                      : action === "default"
                        ? [id, "on"]
                        : [id]),
              ]
            : command === "list"
              ? []
              : [
                  id,
                  ...(["send", "steer", "exec"].includes(command)
                    ? ["fixture"]
                    : command === "report"
                      ? ["ready", "--prompt-id", id]
                      : command === "extend"
                        ? ["--ttl", "1h"]
                        : command === "bind-credential"
                          ? ["--credential-id", id]
                          : []),
                ];
        argv.push("--org", id);
        let requested = false;
        let admissionFailure: unknown;
        await operation(
          command,
          argv,
          {
            out: () => {},
            err: () => {},
            env: { ARMADA_TOKEN: "fixture", ARMADA_URL: "https://dashboard.test" },
            session: memorySessionStore(),
            now: () => new Date(0),
            open: () => {},
            fetch: async (input) => {
              requested = true;
              try {
                await admitted(new URL(String(input)).pathname);
              } catch (error) {
                admissionFailure = error;
              }
              return Response.json({}, { status: 503 });
            },
          },
          async () => "{}",
        ).catch((error: unknown) => {
          // Expected: the fake upstream refuses execution after proving admission.
          if (!requested) throw error;
        });
        if (admissionFailure) throw admissionFailure;
        expect(requested, `No request from ${command} ${action ?? ""}`).toBe(true);
      }
    }
  } finally {
    if (previous === undefined) delete process.env.ARMADA_MCP_URL;
    else process.env.ARMADA_MCP_URL = previous;
  }
});
