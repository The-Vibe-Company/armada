import { defineRailway, project, service } from "railway/iac";

// Own only the server settings, not other services in the Railway project.
export const partial = "armada-server";

export default defineRailway((ctx) => {
  const name = process.env.ARMADA_RAILWAY_SERVICE_NAME;
  if (!name || !ctx.projectName) {
    throw new Error(
      "Link the target Railway project/environment and set ARMADA_RAILWAY_SERVICE_NAME to the existing server service name.",
    );
  }
  return {
    // The CLI reads this project-level policy; variables stay owner-managed.
    variables: { managed: false },
    ...project(ctx.projectName, {
      resources: [
        service(name, {
          // Deliberately omit source: Actions uploads the validated source SHA.
          build: { builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
          deploy: {
            healthcheckPath: "/healthz",
            healthcheckTimeout: 180,
            restartPolicyType: "ALWAYS",
            overlapSeconds: 180,
            drainingSeconds: 30,
          },
        }),
      ],
    }),
  };
});
