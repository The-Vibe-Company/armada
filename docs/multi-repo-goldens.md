# Multi-repository goldens

A golden config lists repositories under `/home/user`, each with a single directory name. Create a multi-repository golden with a JSON config such as:

```json
{
  "repos": [
    { "url": "https://github.com/octocat/Hello-World.git", "branch": "master", "dir": "hello-world" },
    { "url": "https://github.com/The-Vibe-Company/armada.git", "branch": "main", "dir": "armada" }
  ],
  "init": []
}
```

```sh
armada golden create two-repos --config golden.json
armada golden connect two-repos
# Place any allowed setup files in /home/user/hello-world or /home/user/armada, then:
armada golden snapshot two-repos
```

Launch in a selected repository using its configured `dir`, not a host path:

```sh
armada launch two-repos --agent codex --repo armada "Make the requested change"
```

The MCP equivalent first reads `golden_list` to obtain `config.repos[].dir`, then calls:

```json
{"golden":"two-repos","harness":"codex","repo":"armada","prompt":"Make the requested change"}
```

`repo` must exactly match a configured repository directory. Unknown names, traversal such as `../armada`, and absolute paths are rejected. The selected repository is `/home/user/<dir>` in the fork; all repository pulls and golden init still run before the prompt.
