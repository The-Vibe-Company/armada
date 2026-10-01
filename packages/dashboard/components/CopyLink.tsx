"use client";

// Copies an invitation link, so an owner can send it themselves while no
// email provider is configured, or an API key while it is shown.
import { useState } from "react";
import { Button } from "./page";

export function CopyLink({ url, label, done }: { url: string; label: string; done: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(url).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1800);
        });
      }}
    >
      {copied ? done : label}
    </Button>
  );
}
