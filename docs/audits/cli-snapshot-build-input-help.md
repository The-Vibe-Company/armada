# Snapshot build input help (#979)

This help-only slice makes `snapshot create --help` and
`snapshot update --help` discoverable without login. Both accept `-h`;
legacy `golden` spellings display the user-facing name `snapshot`.

Create documents separate Boat/Modal and Docker syntax. Docker requires a host
and organization UUID and uses a request UUID, not Boat/Modal durable-job flags.
Update documents the existing safety boundary: append with `--add-repo`, or
explicitly replace the entire config with `--replace --repo` / `--replace --config`.
Append cannot be combined with replacement/config/init/setup flags.
Docker uses rebuild, not update.

```sh
armada snapshot create starter --provider modal --repo https://github.com/octocat/Hello-World --org my-team
armada snapshot update starter --provider modal --add-repo https://github.com/octocat/Hello-World --org my-team
armada snapshot update starter --provider modal --replace --config all-repositories.json --org my-team
```

Boat/Modal jobs poll for up to 60 seconds by default (maximum 600);
`--timeout 0` returns after admission. Save an idempotency key for uncertain
admission recovery. Disconnecting does not cancel or resubmit an admitted build.
Keep secrets out of config/setup and snapshot contents.

The source audit covers 16 no-session/fake-token help probes across two commands,
two spellings and two flags, with no external requests. Before, only the four
legacy create probes succeed; afterward all 16 succeed. This is help-only,
covered by the ticket's live-audit exemption; authenticated behavior is unchanged.
