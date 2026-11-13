/**
 * The sidebar's structure (#1474): group labels and destinations only, in the owner's order. Pure data, so the order
 * is tested without a browser; the component maps each `icon` name to its glyph.
 */
export type NavIcon =
  | "sandboxes"
  | "otto"
  | "routines"
  | "templates"
  | "environments"
  | "hosts"
  | "skills"
  | "tools"
  | "variables"
  | "models"
  | "settings";

/** A destination behind a server opt-in: the entry appears only once the server says it offers it. */
export type NavOptIn = "dockerHosts";

export type NavLink = { href: string; label: string; icon: NavIcon; optIn?: NavOptIn };
export type NavGroup = { label: string; links: readonly NavLink[] };

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    label: "Run",
    links: [
      { href: "/sandboxes", label: "Sandboxes", icon: "sandboxes" },
      { href: "/otto", label: "Otto", icon: "otto" },
      { href: "/routines", label: "Routines", icon: "routines" },
      { href: "/templates", label: "Templates", icon: "templates" },
    ],
  },
  {
    label: "Library",
    links: [
      { href: "/environments", label: "Environments", icon: "environments" },
      { href: "/hosts", label: "Hosts", icon: "hosts", optIn: "dockerHosts" },
      { href: "/skills", label: "Skills", icon: "skills" },
      { href: "/tools", label: "Tools", icon: "tools" },
      { href: "/variables", label: "Variables", icon: "variables" },
    ],
  },
  {
    label: "Account",
    links: [
      { href: "/harness", label: "Models", icon: "models" },
      { href: "/settings", label: "Settings", icon: "settings" },
    ],
  },
];

/** Whether `pathname` is `href` or a page under it. */
export const isActiveLink = (pathname: string, href: string) => pathname === href || pathname.startsWith(`${href}/`);

/**
 * Whether the sidebar shows anything about organizations: the switcher only to someone who belongs to more than one,
 * and the "create one" prompt to someone with none in scope. A single organization shows nothing.
 */
export const showsOrganizations = (memberships: number, selected: boolean) => !selected || memberships > 1;
