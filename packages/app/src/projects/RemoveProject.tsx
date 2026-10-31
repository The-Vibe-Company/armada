// Remove project (THE-2081), at the bottom of the room's Rules tab: a quiet
// button, then a dialog that says what removing does and sends
// `projects.remove`. The daemon refuses while a worker is in flight; its line
// stays in the dialog. Removed, the app goes back to the hangar.
import { useRef, useState } from "react";
import { Dialog } from "@/components/Dialog";
import { Button } from "@/components/ui/button";
import { useDaemonClient } from "@/protocol/store";

export function RemoveProject({ project }: { project: { id: string; name: string } }) {
  const client = useDaemonClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // The dialog this answer is for: a refusal arriving after it closed is not shown the next time.
  const shown = useRef(0);
  const close = () => {
    shown.current++;
    setOpen(false);
    setBusy(false);
    setProblem(null);
  };
  async function remove() {
    const asked = shown.current;
    setBusy(true);
    setProblem(null);
    try {
      await client.removeProject(project.id);
      window.location.assign("#/");
    } catch (error) {
      if (asked !== shown.current) return;
      setProblem((error instanceof Error && error.message) || "The daemon could not remove this project.");
      setBusy(false);
    }
  }
  return (
    <div data-remove-project className="mt-6 border-line border-t pt-3">
      <Button variant="ghost" className="-ml-3 text-text-3 hover:text-red" onClick={() => setOpen(true)}>
        Remove project
      </Button>
      {open && (
        <Dialog title={`Remove ${project.name}?`} onClose={close}>
          <p className="m-0 text-body text-text-2">Its workers must be stopped first. Its history stays.</p>
          {problem && (
            <p role="alert" className="m-0 text-body text-red">
              {problem}
            </p>
          )}
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" onClick={close} data-autofocus>
              Cancel
            </Button>
            <Button variant="soft" className="text-red" onClick={() => void remove()} disabled={busy}>
              {busy ? "Removing…" : "Remove"}
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
