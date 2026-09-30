# Merging a pull request

`armada merge <pr>` runs this checklist, merges and closes the ticket. When you merge by hand, follow the same steps.

## Before

1. The worker has handed back: `Agent phase` is `ready-to-merge` and you have the full 40-character head SHA it reported.
2. `gh pr view <n> --json headRefOid,mergeStateStatus,isDraft,title` shows that SHA, `CLEAN`, not a draft, and a Commitizen title.
3. `gh pr checks <n>` shows every required check passing.
4. The head contains the current default branch: `git merge-base --is-ancestor origin/<default> <sha>`. If not, ask the worker to rebase.
5. Semantic check: search the default branch for callers of anything the pull request deletes or renames.

## Merge

```sh
gh pr merge <n> --squash --match-head-commit <full-sha>
```

- One merge at a time.
- Leave out `--delete-branch`: it deletes local worktrees that have the branch checked out, including other agents'. Delete the branch once its worktree is gone.
- If GitHub answers with a 5xx, check `gh pr view <n> --json state` before retrying.

## After

1. The ticket is Done, its `Agent phase` and `Agent runtime` labels removed, the pull request linked.
2. Tell every in-flight worker what the merge changes for them: a shared file, a migration, a new check, code they must now reuse or delete.
3. Launch the tickets this merge unblocked.
