import { redirect } from "next/navigation";

// The Projects list is gone (THE-1021): the overview has a card per project, the sidebar a line each.
export default function ProjectsPage() {
  redirect("/");
}
