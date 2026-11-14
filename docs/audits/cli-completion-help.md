# Shell-completion discovery (#979)

Focused help now covers `completion` and its existing bash/zsh/fish selectors
with either help flag before authentication or I/O.
Only exact boundaries are intercepted; unsupported shells and other arguments
keep their existing validation.

```sh
armada completion --help
armada completion bash --help
armada completion zsh --help
armada completion fish --help
armada completion bash > armada-completion.bash
```

Generation writes a script to stdout and does not install it or change shell
configuration. Choose your actual shell and inspect the script before sourcing
it. Neither generation nor help requires login or a network request.
Generated script contents and runtime behavior are unchanged.

Offline run.ts audit: 16 help probes across four paths, both flags and
no-session/fake-token modes; before, 12 shell-specific probes fail and four family
probes show broad root help. After, all 16 show focused help, zero requests.
No generated scripts are executed. This pure client help slice uses the issue's
audit exemption; no staging/TTY results are claimed.
