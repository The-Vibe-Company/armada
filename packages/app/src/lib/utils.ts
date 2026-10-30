import { createCn } from "cn/config";

/** The v7 theme's names `cn` must know; test/anatomy.test.tsx holds them to src/styles.css's @theme. */
export const THEME_NAMES = {
  text: ["label", "heading", "small", "meta", "body", "sub", "compose", "bar", "title"],
  radius: ["xs", "sm", "md", "control", "btn", "card", "lg", "deck"],
  shadow: ["ring", "ring-hover", "control", "control-hover", "pop"],
};

// shadcn's `cn` (clsx + tailwind-merge's rules), told the v7 theme's names: by
// default it takes `text-body` (a size) and `text-text-2` (a colour) for the
// same group and drops the first.
export const cn = createCn({ extend: { theme: THEME_NAMES } });
