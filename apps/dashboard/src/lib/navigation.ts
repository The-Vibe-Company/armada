/**
 * The sidebar's structure (#1474): group labels and destinations only, in the owner's order. Pure data, so the order
 * is tested without a browser; the component maps each `icon` name to its glyph.
 */
export type NavIcon =
  | "sandboxes"
  | "routines"
  | "templates"
  | "environments"
  | "skills"
  | "tools"
  | "variables"
  | "selfHosted"
  | "cloud"
  | "models"
  | "settings";

/** A destination behind a server opt-in: the entry appears only once the server says it offers it. */
export type NavOptIn = "dockerHosts";

export type NavLink = { href: string; label: string; icon: NavIcon; optIn?: NavOptIn };
export type NavGroup = { label: string; links: readonly NavLink[] };

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    label: "Running",
    links: [
      { href: "/sandboxes", label: "Sandboxes", icon: "sandboxes" },
      { href: "/routines", label: "Routines", icon: "routines" },
    ],
  },
  {
    label: "Launch from",
    links: [
      { href: "/templates", label: "Templates", icon: "templates" },
      { href: "/snapshots", label: "Snapshots", icon: "environments" },
    ],
  },
  {
    label: "What agents have",
    links: [
      { href: "/harness", label: "Models", icon: "models" },
      { href: "/tools", label: "Tools", icon: "tools" },
      { href: "/skills", label: "Skills", icon: "skills" },
      { href: "/variables", label: "Variables", icon: "variables" },
    ],
  },
  {
    label: "Setup",
    links: [
      { href: "/providers/cloud", label: "Machines", icon: "cloud" },
      { href: "/orgs", label: "Organization", icon: "selfHosted" },
      { href: "/settings", label: "Your connections", icon: "settings" },
    ],
  },
];

/** Whether `pathname` is `href` or a page under it. */
export const isActiveLink = (pathname: string, href: string) => {
  const canonical =
    pathname === "/hosts" || pathname.startsWith("/hosts/")
      ? pathname.replace(/^\/hosts/, "/providers/cloud")
      : pathname;
  return canonical === href || canonical.startsWith(`${href}/`);
};

/**
 * Whether the sidebar shows anything about organizations: the switcher only to someone who belongs to more than one,
 * and the "create one" prompt to someone with none in scope. A single organization shows nothing.
 */
export const showsOrganizations = (memberships: number, selected: boolean) => !selected || memberships > 1;
