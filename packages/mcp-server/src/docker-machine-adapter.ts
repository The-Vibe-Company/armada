import type { Machine } from "@armada/core/server";

type MailboxResult<T> = { kind: "pending" | "unknown" } | { kind: "completed"; value: T };
type MailboxOperation<Operation extends "create" | "bootstrap" | "resume" | "delete"> = (
  request: Parameters<Machine[Operation]>[0],
) => Promise<MailboxResult<Awaited<ReturnType<Machine[Operation]>>>>;

export type DockerMachineMailbox = Pick<Machine, "observe" | "stop" | "listInventory"> & {
  create: MailboxOperation<"create">;
  bootstrap: MailboxOperation<"bootstrap">;
  resume: MailboxOperation<"resume">;
  delete: MailboxOperation<"delete">;
};

export class DockerMachinePending extends Error {
  constructor(readonly outcome: "pending" | "unknown") {
    super(`Docker Machine outcome is ${outcome}.`);
  }
}

function completed<T>(result: MailboxResult<T>) {
  if (result.kind !== "completed") throw new DockerMachinePending(result.kind);
  return result.value;
}

export function createDockerMachineAdapter(mailbox: DockerMachineMailbox) {
  const machine: Machine = {
    async create(request) {
      return completed(await mailbox.create(request));
    },
    async bootstrap(request) {
      completed(await mailbox.bootstrap(request));
    },
    async resume(request) {
      return completed(await mailbox.resume(request));
    },
    async delete(request) {
      completed(await mailbox.delete(request));
    },
    stop: mailbox.stop,
    observe: mailbox.observe,
    ...(mailbox.listInventory && { listInventory: mailbox.listInventory }),
  };
  return machine;
}
