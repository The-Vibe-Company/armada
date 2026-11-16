"use client";

import type { ComponentProps } from "react";
import { ResourceBrowser } from "@/components/resource-browser";
import styles from "./catalog-browser.module.css";

/** Catalog presentation; the resource browser retains URL, keyboard and focus behavior. */
export function CatalogBrowser(props: ComponentProps<typeof ResourceBrowser>) {
  return (
    <div className={styles.catalog} data-catalog={props.title}>
      <ResourceBrowser {...props} />
    </div>
  );
}
