"use client";

import type { ComponentProps } from "react";
import { ResourceBrowser } from "@/components/resource-browser";
import styles from "./catalog-browser.module.css";

/** Catalog presentation; the resource browser retains URL, keyboard and focus behavior. */
export function CatalogBrowser(props: ComponentProps<typeof ResourceBrowser>) {
  return (
    <div
      className={styles.catalog}
      data-catalog={props.title}
      data-fidelity={props.title === "Snapshots" || props.title === "Templates" || undefined}
    >
      <ResourceBrowser
        {...props}
        catalogFilters={
          props.catalogFilters ??
          (props.title === "Snapshots"
            ? [
                { key: "all", label: "All" },
                { key: "boat", label: "Boat" },
                { key: "modal", label: "Modal" },
                ...(props.rows.some((row) => row.catalog?.group === "docker")
                  ? [{ key: "docker", label: "Docker" }]
                  : []),
                { key: "attention", label: "Needs attention" },
              ]
            : props.title === "Templates"
              ? [
                  { key: "all", label: "All" },
                  { key: "claude", label: "Claude Code" },
                  { key: "codex", label: "Codex" },
                  ...(props.rows.some((row) => row.catalog?.group === "opencode")
                    ? [{ key: "opencode", label: "OpenCode" }]
                    : []),
                ]
              : undefined)
        }
      />
    </div>
  );
}
