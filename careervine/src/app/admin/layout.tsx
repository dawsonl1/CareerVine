import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";
import { isAdmin } from "@/lib/admin";
import Navigation from "@/components/navigation";

/**
 * Server-side gate for the entire /admin surface. The API routes behind it
 * independently enforce `requireAdmin`, so this is defense-in-depth — but it
 * also means non-admins never see the admin UI at all.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!isAdmin(user)) {
    redirect("/");
  }

  return (
    <div className="min-h-screen bg-background">
      <Navigation />
      <main className="mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8 py-8">
        {children}
      </main>
    </div>
  );
}
