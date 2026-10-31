// Add project (THE-2081): the folder first, chosen in the system's dialog
// through the desktop shell's bridge (a text field in a browser); the daemon
// inspects it (`projects.inspect`) and the form shows what it read: the
// repository its remote or armada.toml names, the folder's name, the Linear
// program armada.toml names, and its problems in amber. Add sends
// `projects.add`; the daemon's answer (`projects.result`, pushed to every
// window) lists the project and the dialog closes; a refusal stays under the
// form in red. The account's repositories and Linear projects are not listed
// by any provider yet: both fields are free text.
import type { ProjectInspection } from "@armada/protocol";
import { type FormEvent, useId, useRef, useState } from "react";
import { Dialog } from "@/components/Dialog";
import { Field, Form, Input } from "@/components/page";
import { Button } from "@/components/ui/button";
import { useDaemonClient } from "@/protocol/store";
import { fieldsOf, idOf, isRepository, type ProjectFields, problemsOf, readable, ready, tomlProgram } from "./form";

const problemOf = (error: unknown, fallback: string) => (error instanceof Error && error.message) || fallback;

export default function AddProject({ onClose }: { onClose: () => void }) {
  const client = useDaemonClient();
  const pick = typeof window === "undefined" ? undefined : window.armadaShell?.pickFolder;
  const ids = useId();
  const [folder, setFolder] = useState("");
  const [inspection, setInspection] = useState<ProjectInspection | null>(null);
  const [fields, setFields] = useState<ProjectFields>({ repository: "", name: "", program: "" });
  const [busy, setBusy] = useState<"inspecting" | "adding" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // The folder last asked about: an answer for an older one is dropped.
  const asked = useRef("");

  async function inspect(path: string) {
    const target = path.trim();
    if (!target) return;
    asked.current = target;
    setBusy("inspecting");
    setProblem(null);
    try {
      const answer = await client.inspectProject(target);
      if (asked.current !== target) return;
      setInspection(answer);
      setFolder(answer.path);
      setFields(fieldsOf(answer));
    } catch (error) {
      if (asked.current === target) setProblem(problemOf(error, "The daemon could not read this folder."));
    } finally {
      if (asked.current === target) setBusy(null);
    }
  }

  async function browse() {
    if (!pick) return;
    const path = await pick().catch(() => null);
    if (path) {
      setFolder(path);
      await inspect(path);
    }
  }

  async function add() {
    if (!inspection || !ready(fields)) return;
    setBusy("adding");
    setProblem(null);
    try {
      const program = fields.program.trim();
      await client.addProject({
        path: inspection.path,
        id: idOf(fields.name, inspection),
        name: fields.name.trim(),
        repository: fields.repository.trim(),
        ...(program ? { programRoot: program } : {}),
      });
      onClose();
    } catch (error) {
      setProblem(problemOf(error, "The daemon could not add this project."));
      setBusy(null);
    }
  }

  // Enter adds the project; a folder typed or changed since its last reading is read first.
  function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!inspection || folder.trim() !== inspection.path) void inspect(folder);
    else void add();
  }

  const set = (key: keyof ProjectFields) => (event: { currentTarget: HTMLInputElement }) =>
    setFields({ ...fields, [key]: event.currentTarget.value });
  const read = inspection && folder.trim() === inspection.path ? inspection : null;
  // A path the daemon cannot open shows its problem, and no form: the daemon would refuse it.
  const shown = read && readable(read) ? read : null;
  // armada.toml's program: the daemon adds the project under it when the field is left empty.
  const fromToml = shown ? tomlProgram(shown) : undefined;
  const problems = read ? problemsOf(read) : [];
  const repository = fields.repository.trim();
  const badRepository = repository !== "" && !isRepository(repository);
  return (
    <Dialog title="Add a project" onClose={onClose}>
      <Form onSubmit={submit} aria-label="Add a project" className="max-w-none" noValidate>
        <Field
          label="Folder"
          htmlFor={`${ids}-folder`}
          hint={pick ? undefined : "The folder's full path, on the daemon's machine."}
        >
          <div className="flex min-w-0 gap-2">
            <Input
              id={`${ids}-folder`}
              value={folder}
              readOnly={Boolean(pick)}
              placeholder={pick ? "Choose a folder" : "/Users/you/Dev/project"}
              onChange={(e) => setFolder(e.currentTarget.value)}
              onKeyDown={(e) => {
                // Enter on the folder reads it; elsewhere it adds the project.
                if (e.key !== "Enter" || pick) return;
                e.preventDefault();
                if (!busy) void inspect(folder);
              }}
              className="font-mono"
              spellCheck={false}
              autoComplete="off"
              data-autofocus={pick ? undefined : true}
            />
            {pick ? (
              <Button
                type="button"
                variant="soft"
                onClick={() => void browse()}
                disabled={busy !== null}
                data-autofocus
              >
                Browse…
              </Button>
            ) : (
              <Button
                type="button"
                variant="soft"
                onClick={() => void inspect(folder)}
                disabled={busy !== null || !folder.trim()}
              >
                Read
              </Button>
            )}
          </div>
        </Field>
        {busy === "inspecting" && <p className="m-0 text-body text-text-3">Reading the folder…</p>}
        {problems.length > 0 && (
          <ul data-problems className="m-0 flex list-none flex-col gap-1 p-0 text-body text-amber">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        {shown && (
          <>
            <Field
              label="Repository"
              htmlFor={`${ids}-repository`}
              hint={badRepository ? <span className="text-amber">As owner/repo, on GitHub.</span> : undefined}
            >
              <Input
                id={`${ids}-repository`}
                value={fields.repository}
                onChange={set("repository")}
                placeholder="owner/repo"
                className="font-mono"
                spellCheck={false}
                autoComplete="off"
                aria-invalid={badRepository || undefined}
                autoFocus={!shown.suggested.repository}
              />
            </Field>
            <Field label="Name" htmlFor={`${ids}-name`}>
              <Input id={`${ids}-name`} value={fields.name} onChange={set("name")} autoComplete="off" />
            </Field>
            <Field
              label="Linear program"
              htmlFor={`${ids}-program`}
              hint={
                fromToml
                  ? `Optional: the issue at the root of the project's plan. Empty, armada.toml's ${fromToml}.`
                  : "Optional: the issue at the root of the project's plan. Empty, the project runs without Linear."
              }
            >
              <Input
                id={`${ids}-program`}
                value={fields.program}
                onChange={set("program")}
                placeholder={fromToml ?? "Without Linear"}
                className="font-mono"
                spellCheck={false}
                autoComplete="off"
              />
            </Field>
          </>
        )}
        {problem && (
          <p role="alert" className="m-0 text-body text-red">
            {problem}
          </p>
        )}
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!shown || !ready(fields) || busy !== null}>
            {busy === "adding" ? "Adding…" : "Add"}
          </Button>
        </div>
      </Form>
    </Dialog>
  );
}
