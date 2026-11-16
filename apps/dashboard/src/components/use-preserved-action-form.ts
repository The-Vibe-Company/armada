"use client";

import { useLayoutEffect, useState } from "react";

const explicitResets = new WeakSet<HTMLFormElement>();

/** Permit only this synchronous, confirmed-success reset; later action resets still preserve the draft. */
export function resetPreservedActionForm(form: HTMLFormElement) {
  explicitResets.add(form);
  try {
    form.reset();
  } finally {
    explicitResets.delete(form);
  }
}

/**
 * React action resets must not ask controlled Radix fields to restore their initial choices or fire actions.
 * Keep their state/native form values, while retaining the original one-attempt lifetime of uncontrolled secrets.
 * The callback ref also handles dialogs whose forms mount only after opening or remount after a success.
 */
export function usePreservedActionForm() {
  const [form, setForm] = useState<HTMLFormElement | null>(null);
  useLayoutEffect(() => {
    if (!form) return;
    const keep = (event: Event) => {
      if (explicitResets.has(form)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      for (const field of form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        'input[type="password"], textarea[data-secret-value]',
      )) {
        field.value = "";
      }
    };
    form.addEventListener("reset", keep, true);
    return () => form.removeEventListener("reset", keep, true);
  }, [form]);
  return setForm;
}
