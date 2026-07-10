import { redirect } from "next/navigation";

/** /admin lands on the users list — the primary admin surface. */
export default function AdminPage() {
  redirect("/admin/users");
}
