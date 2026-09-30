---
name: armada-runtime-conductor
description: Runtime guide for running Armada workers on Conductor. Use when an Armada coordinator must launch a worker, send it a message, check whether it is alive, or stop and archive it on Conductor. Four fixed sections, each with the conductor command and how to read its output.
---

Armada never calls a runtime itself. This guide tells the coordinator how to do the four runtime actions with the `conductor` command line tool, and what to record in Armada afterwards. Check the exact flags with `conductor --help` and `conductor <command> --help`: this first version gives the commands to use, and a later Armada release completes the options and sample outputs.

## Launch

```sh
conductor workspace create --repo <owner/name> --branch <ticket branch>
```

Pass the prompt from `armada brief <ticket>` as the first message, and the environment variables it lists. Read the workspace id and the session id from the output; they form the handle `<workspace>/<session>`. Record it with `armada claim <ticket> --runtime conductor --handle <workspace>/<session>` unless the worker claims it itself.

## Message

```sh
conductor message create --workspace <workspace> --session <session> --message "<text>"
```

Use it to deliver an answer, an approval or a heads-up that the default branch moved. A zero exit code means Conductor accepted the message; it does not mean the worker read it. After delivering an answer, record it with `armada answer`.

## Status

```sh
conductor session status --workspace <workspace> --session <session>
```

Tells whether the session is running, idle or ended. A silent worker whose session is running is busy: nudge it to report. An idle or ended session with the ticket not handed back needs a message or a relaunch.

## Stop and archive

```sh
conductor workspace archive --workspace <workspace>
```

Archive a worker's workspace after its pull request is merged, or when its ticket is released. Archiving stops the session and frees the workspace; the branch and the pull request stay on GitHub.
