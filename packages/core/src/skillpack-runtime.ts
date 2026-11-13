/** Official public Skillpack runtime release, shared by golden and enrolled-runtime preparation. */
export const SKILLPACK_RUNTIME = {
  version: "0.3.5",
  archives: {
    x64: {
      target: "linux_amd64",
      sha256: "523a6f2d18a18e252ddcfd687c1668335d567b1f1f83b5ebb0849c19b701e916",
      bytes: 10079479,
    },
    arm64: {
      target: "linux_arm64",
      sha256: "b1a42ad81013871aa670f772e3d8d3e17c6f25a76af45bf361394b3726fbe54d",
      bytes: 9410420,
    },
  },
} as const;
