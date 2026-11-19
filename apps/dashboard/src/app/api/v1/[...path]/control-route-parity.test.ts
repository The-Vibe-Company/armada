import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { operation } from "../../../../../../../packages/cli/src/operations.ts";
import { memorySessionStore } from "../../../../../../../packages/cli/src/session.ts";
import { forwardControl } from "./control-proxy.ts";

const cli = resolve(import.meta.dir, "../../../../../../../packages/cli/src");
const id = "11111111-1111-4111-8111-111111111111";

test("CLI user POST routes reach the dashboard proxy while machine-token routes stay outside it", async () => {
  const files = readdirSync(cli)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => resolve(cli, name));
  const program = ts.createProgram(files, {
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    module: ts.ModuleKind.ESNext,
    strict: true,
    types: [],
    lib: ["lib.es2023.d.ts"],
  });
  const checker = program.getTypeChecker();
  const sources = program.getSourceFiles().filter((source) => files.includes(source.fileName));
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) calls.push(node);
    ts.forEachChild(node, visit);
  };
  for (const source of sources) visit(source);
  const owner = (node: ts.Node) => {
    for (let parent = node.parent; parent; parent = parent.parent) if (ts.isFunctionDeclaration(parent)) return parent;
    return undefined;
  };
  const fail = (node: ts.Node) => {
    throw new Error(`Unresolved CLI route: ${node.getSourceFile().fileName}: ${node.getText()}`);
  };
  const finiteType: (type: ts.Type) => string[] | undefined = (type) => {
    if (type.isStringLiteral()) return [type.value];
    if (type.isUnion()) {
      const values = type.types.map(finiteType);
      if (values.every((value) => value !== undefined)) return values.flat() as string[];
    }
    const constraint = checker.getBaseConstraintOfType(type);
    return constraint && constraint !== type ? finiteType(constraint) : undefined;
  };
  const strings: (node: ts.Expression, seen?: Set<ts.Node>) => string[] = (node, seen = new Set<ts.Node>()) => {
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
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "apiUrl")
      return strings(node.arguments[1] ?? fail(node), next);
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "encodeURIComponent"
    ) {
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
        const earlyReturnValues: (condition: ts.Expression) => string[] = (condition) => {
          if (!ts.isBinaryExpression(condition)) return [];
          if (condition.operatorToken.kind === ts.SyntaxKind.BarBarToken)
            return [...earlyReturnValues(condition.left), ...earlyReturnValues(condition.right)];
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
              ? earlyReturnValues(statement.expression)
              : [],
          ) ?? [];
        return validation.expression.expression.elements
          .flatMap((element) => strings(element, next))
          .filter((value) => !excluded.includes(value));
      }
    }
    return fail(node);
  };

  const userRoutes = new Set<string>();
  const machineRoutes = new Set<string>();
  for (const call of calls) {
    const declaration = checker.getResolvedSignature(call)?.declaration;
    const control =
      declaration &&
      ts.isFunctionDeclaration(declaration) &&
      declaration.getSourceFile().fileName === resolve(cli, "control.ts");
    if (control) {
      const mutableOwner = owner(call);
      const realDispatch =
        (mutableOwner?.name?.text === "operation" && call.getSourceFile().fileName === resolve(cli, "operations.ts")) ||
        (mutableOwner?.name?.text === "mcpCommand" &&
          call.getSourceFile().fileName === resolve(cli, "mcp-commands.ts"));
      if (realDispatch && call.arguments[1]?.getText() === "route") continue;
      for (const route of strings(call.arguments[1] ?? fail(call))) userRoutes.add(`/api/v1/${route}`);
      continue;
    }
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
    if (call.getSourceFile().fileName === resolve(cli, "armada-api.ts") && path.getText() === "url") continue;
    const machinePath =
      ts.isTemplateExpression(path) && path.head.text === "" && path.templateSpans.length === 1
        ? path.templateSpans[0]?.literal.text
        : undefined;
    for (const route of machinePath?.startsWith("/api/docker-host/") ? [machinePath] : strings(path)) {
      if (route.startsWith("/api/docker-host/")) machineRoutes.add(route);
      else userRoutes.add(route);
    }
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
    for (const route of userRoutes) await admitted(route);
    for (const route of machineRoutes) {
      const path = route.slice("/api/".length);
      const response = await forwardControl(
        new Request(`https://dashboard.test/api/v1/${path}`, {
          method: "POST",
          headers: { authorization: "Bearer fixture-user-token", "content-type": "application/json" },
          body: "{}",
        }),
        path.split("/"),
        Object.assign(
          async () => {
            throw new Error(`Machine-token route ${route} must not be forwarded by the user proxy`);
          },
          { preconnect: fetch.preconnect },
        ),
      );
      expect(response.status).toBe(404);
    }
    const operationCall = calls.find(
      (call) =>
        checker.getResolvedSignature(call)?.declaration?.getSourceFile().fileName === resolve(cli, "operations.ts") &&
        ts.isIdentifier(call.expression) &&
        call.expression.text === "operation",
    );
    const commands = strings(operationCall?.arguments[0] ?? fail(sources[0] as ts.Node));
    const mcpCall = calls.find(
      (call) =>
        owner(call)?.name?.text === "operation" &&
        checker.getResolvedSignature(call)?.declaration?.getSourceFile().fileName === resolve(cli, "mcp-commands.ts"),
    );
    const mcpSource = checker
      .getResolvedSignature(mcpCall ?? fail(sources[0] as ts.Node))
      ?.declaration?.getSourceFile();
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
    findActions(mcpSource ?? fail(sources[0] as ts.Node));
    expect(commands).toContain("mcp");
    expect(actions?.length).toBeGreaterThan(0);
    for (const command of commands) {
      if (command === "rm") continue;
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

test("CLI status and stop forward authenticated scope through the public proxy", async () => {
  const org = "22222222-2222-4222-8222-222222222222";
  const token = "fixture-owner";
  const previous = process.env.ARMADA_MCP_URL;
  process.env.ARMADA_MCP_URL = "https://control.test/mcp";
  try {
    for (const command of ["status", "stop"]) {
      const expectedBody = command === "status" ? { id, org, recorded: true } : { id, org };
      const path = `/api/v1/sandbox/${command}`;
      const forwarded: Request[] = [];
      await operation(
        command,
        [id, "--org", org, "--json"],
        {
          env: { ARMADA_TOKEN: token, ARMADA_URL: "https://dashboard.test" },
          fetch: async (input, init) => {
            const incoming = new Request(input, init);
            expect(incoming.url).toBe(`https://dashboard.test${path}`);
            return forwardControl(
              incoming,
              new URL(incoming.url).pathname.slice("/api/v1/".length).split("/"),
              async (target, options) => {
                forwarded.push(new Request(target, options));
                return Response.json({ id, status: "stopped", settled: true, prompt: null });
              },
            );
          },
          session: memorySessionStore(),
          now: () => new Date(0),
          open: () => {},
          out: () => {},
          err: () => {},
        },
        async () => "",
      );
      expect(forwarded).toHaveLength(1);
      const upstream = forwarded[0];
      expect(upstream?.url).toBe(`https://control.test${path}`);
      expect(upstream?.method).toBe("POST");
      expect(upstream?.headers.get("authorization")).toBe(`Bearer ${token}`);
      expect(upstream?.headers.get("accept")).toBe("application/json");
      expect(upstream?.headers.get("content-type")).toBe("application/json");
      expect(await upstream?.json()).toEqual(expectedBody);
    }
  } finally {
    if (previous === undefined) delete process.env.ARMADA_MCP_URL;
    else process.env.ARMADA_MCP_URL = previous;
  }
});
