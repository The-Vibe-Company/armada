import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { currentRequestId } from "./request-observability.ts";

/** Include a quoteable ID in tool failures even when the MCP client hides HTTP headers. */
export function createObservedMcpTransport() {
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  const send = transport.send.bind(transport);
  transport.send = (message, sendOptions) => {
    if ("result" in message && message.result.isError === true) {
      const requestId = currentRequestId();
      return send(
        { ...message, result: { ...message.result, _meta: { ...message.result._meta, requestId } } },
        sendOptions,
      );
    }
    return send(message, sendOptions);
  };
  return transport;
}
