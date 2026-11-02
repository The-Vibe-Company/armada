// The app's strings, in English and French (THE-2124: the Tickets page's
// first; the rest of the app moves here a screen at a time). Each key is
// `<screen>.<what>`; a `{name}` in a string is filled by the caller's value.
// English is complete by definition; French must give every key (a type
// error otherwise). The language is the viewer's, French for any `fr` tag
// first among the browser's, English otherwise and off a browser.
import { useSyncExternalStore } from "react";

const en = {
  "tickets.title": "Tickets",
  "tickets.back": "Back to the room",
  "tickets.new": "New ticket",
  "tickets.group.ready": "Ready to launch",
  "tickets.group.flight": "In flight",
  "tickets.group.backlog": "Backlog",
  "tickets.group.done": "Done",
  "tickets.empty.ready": "Nothing is ready to launch.",
  "tickets.empty.flight": "Nothing in flight.",
  "tickets.empty.backlog": "Nothing in the backlog.",
  "tickets.reading": "Reading the project's log",
  "tickets.none": "The daemon has no such project.",
  "tickets.waiting": "Waiting for the daemon to list its projects.",
  "tickets.linear": "This project's tickets live in Linear",
  "tickets.parent": "Parent {id}",
  "tickets.state": "State",
  "tickets.labels": "Labels",
  "tickets.parentField": "Parent",
  "tickets.blockers": "Blocked by",
  "tickets.comments": "Comments",
  "tickets.noDescription": "No description.",
  "tickets.missing": "No ticket {id} in this project.",
  "tickets.close": "Close the panel",
  "tickets.panel": "Ticket",
  "tickets.markReady": "Mark ready",
  "tickets.notReady": "Not ready",
  "tickets.edit": "Edit",
  "tickets.cancel": "Cancel ticket",
  "tickets.launch": "Launch",
  "tickets.launchAsked": "Asked the coordinator to launch it.",
  "tickets.status.triage": "Triage",
  "tickets.status.backlog": "Backlog",
  "tickets.status.unstarted": "Todo",
  "tickets.status.started": "Started",
  "tickets.status.completed": "Done",
  "tickets.status.canceled": "Canceled",
  "tickets.form.title": "Title",
  "tickets.form.description": "Description",
  "tickets.form.descriptionHint": "Markdown.",
  "tickets.form.labels": "Labels",
  "tickets.form.labelsHint": "Separated by commas.",
  "tickets.form.parent": "Parent",
  "tickets.form.parentHint": "A ticket's id, or nothing.",
  "tickets.form.ready": "Ready to launch",
  "tickets.form.create": "Create ticket",
  "tickets.form.save": "Save",
  "tickets.form.discard": "Discard",
  "tickets.form.saving": "Saving…",
  "tickets.form.needsTitle": "Give the ticket a title.",
} as const;

export type StringKey = keyof typeof en;
type Strings = Record<StringKey, string>;

const fr: Strings = {
  "tickets.title": "Tickets",
  "tickets.back": "Retour à la salle",
  "tickets.new": "Nouveau ticket",
  "tickets.group.ready": "Prêts à lancer",
  "tickets.group.flight": "En vol",
  "tickets.group.backlog": "Backlog",
  "tickets.group.done": "Terminés",
  "tickets.empty.ready": "Rien n'est prêt à lancer.",
  "tickets.empty.flight": "Rien en vol.",
  "tickets.empty.backlog": "Rien dans le backlog.",
  "tickets.reading": "Lecture du journal du projet",
  "tickets.none": "Le daemon n'a pas ce projet.",
  "tickets.waiting": "En attente de la liste des projets du daemon.",
  "tickets.linear": "Les tickets de ce projet sont dans Linear",
  "tickets.parent": "Parent {id}",
  "tickets.state": "État",
  "tickets.labels": "Labels",
  "tickets.parentField": "Parent",
  "tickets.blockers": "Bloqué par",
  "tickets.comments": "Commentaires",
  "tickets.noDescription": "Pas de description.",
  "tickets.missing": "Pas de ticket {id} dans ce projet.",
  "tickets.close": "Fermer le panneau",
  "tickets.panel": "Ticket",
  "tickets.markReady": "Marquer prêt",
  "tickets.notReady": "Pas prêt",
  "tickets.edit": "Modifier",
  "tickets.cancel": "Annuler le ticket",
  "tickets.launch": "Lancer",
  "tickets.launchAsked": "Le coordinateur a été prié de le lancer.",
  "tickets.status.triage": "Tri",
  "tickets.status.backlog": "Backlog",
  "tickets.status.unstarted": "À faire",
  "tickets.status.started": "Commencé",
  "tickets.status.completed": "Terminé",
  "tickets.status.canceled": "Annulé",
  "tickets.form.title": "Titre",
  "tickets.form.description": "Description",
  "tickets.form.descriptionHint": "Markdown.",
  "tickets.form.labels": "Labels",
  "tickets.form.labelsHint": "Séparés par des virgules.",
  "tickets.form.parent": "Parent",
  "tickets.form.parentHint": "L'id d'un ticket, ou rien.",
  "tickets.form.ready": "Prêt à lancer",
  "tickets.form.create": "Créer le ticket",
  "tickets.form.save": "Enregistrer",
  "tickets.form.discard": "Abandonner",
  "tickets.form.saving": "Enregistrement…",
  "tickets.form.needsTitle": "Donnez un titre au ticket.",
};

export type Language = "en" | "fr";
export const STRINGS: Record<Language, Strings> = { en, fr };

/** The language of the first tag the app speaks among the viewer's, English otherwise. */
export function languageOf(tags: readonly string[]): Language {
  for (const tag of tags) {
    const base = tag.toLowerCase().split("-")[0];
    if (base === "fr") return "fr";
    if (base === "en") return "en";
  }
  return "en";
}

/** A key's string in a language, each `{name}` filled from `values`. */
export function translate(language: Language, key: StringKey, values: Record<string, string | number> = {}): string {
  return STRINGS[language][key].replace(/\{(\w+)\}/g, (all, name: string) =>
    name in values ? String(values[name]) : all,
  );
}

export type Translate = (key: StringKey, values?: Record<string, string | number>) => string;

const browserLanguage = (): Language =>
  typeof navigator === "undefined"
    ? "en"
    : languageOf(navigator.languages?.length ? navigator.languages : [navigator.language]);
const onLanguage = (change: () => void) => {
  window.addEventListener("languagechange", change);
  return () => window.removeEventListener("languagechange", change);
};

/** The viewer's language, followed when the browser's changes; English off a browser. */
export function useLanguage(): Language {
  return useSyncExternalStore(onLanguage, browserLanguage, () => "en");
}

/** The strings in the viewer's language. */
export function useT(): Translate {
  const language = useLanguage();
  return (key, values) => translate(language, key, values);
}
