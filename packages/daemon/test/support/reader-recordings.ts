// Synthetic GraphQL recordings shared by reader composition tests.
export const project = { id: "orchard", name: "Orchard", repository: "example/orchard", programRoot: "SEED-1" };
export const now = () => new Date("2030-01-01T10:00:00Z");
export const page = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
export const issue = (id: string, phase?: string) => ({
  id: `uuid-${id}`,
  identifier: id,
  title: `Grow ${id}`,
  url: `https://linear.example/issue/${id}`,
  state: { type: phase ? "started" : "backlog" },
  assignee: { name: "Mira" },
  parent: id === "SEED-1" ? null : { identifier: "SEED-1" },
  labels: page(phase ? [{ name: phase, parent: { name: "Agent phase" } }] : []),
  attachments: page([]),
});
export const github = {
  repository: {
    open: page([
      {
        number: 41,
        title: "Grow the orchard",
        url: "https://github.com/example/orchard/pull/41",
        state: "OPEN",
        isDraft: false,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        headRefName: "feature/seed-2-grow",
        headRefOid: "aaa",
        reviewDecision: "APPROVED",
        commits: {
          nodes: [
            {
              commit: {
                oid: "aaa",
                checkSuites: { nodes: [], pageInfo: { hasNextPage: false } },
                statusCheckRollup: null,
              },
            },
          ],
        },
      },
    ]),
  },
};
