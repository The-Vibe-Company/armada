import { type ProjectRequest, type ServerMessage, PROTOCOL_VERSION as version } from "@armada/protocol";
import { inspectProject, ProjectRefusal, type Projects } from "../projects.ts";
import { WorkerRefusal } from "../workers/service.ts";

export async function dispatchProjects(request: ProjectRequest, registry?: Projects): Promise<ServerMessage> {
  const base = { version, id: request.id };
  try {
    if (request.type === "projects.inspect")
      return { ...base, type: "projects.inspection", ...(await inspectProject(request.path)) };
    if (!registry)
      return { ...base, type: "error", code: "not-found", message: "This daemon has no writable project registry" };
    const projects =
      request.type === "projects.add"
        ? await registry.add({ ...request, id: request.projectId })
        : await registry.remove(request.project);
    return { ...base, type: "projects.result", projects: [...projects] };
  } catch (error) {
    const refusal = error instanceof ProjectRefusal || error instanceof WorkerRefusal;
    return {
      ...base,
      type: "error",
      code: refusal ? "invalid-message" : "internal",
      message: refusal ? error.message : "Could not update the project registry; no change was confirmed",
    };
  }
}
