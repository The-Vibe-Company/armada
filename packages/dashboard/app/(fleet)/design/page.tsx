import { redirect } from "next/navigation";

// The component sheet is gone (THE-1021): the v7 design is the dashboard's reference.
export default function DesignPage() {
  redirect("/");
}
