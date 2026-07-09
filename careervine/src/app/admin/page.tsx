import Link from "next/link";
import { Users } from "lucide-react";

/**
 * Admin home. Slice 1 replaces this with the searchable users list; for now it
 * is the landing behind the admin gate so the route exists and is reachable.
 */
export default function AdminPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-on-surface">Admin</h1>
      <p className="mt-1 text-sm text-on-surface-variant">
        Manage user accounts, access, and AI settings.
      </p>

      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        <Link
          href="/admin/users"
          className="flex items-center gap-3 rounded-2xl border border-outline-variant bg-surface p-4 transition-colors hover:bg-surface-container"
        >
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-primary-container text-on-primary-container">
            <Users size={20} />
          </span>
          <span>
            <span className="block font-medium text-on-surface">Users</span>
            <span className="block text-sm text-on-surface-variant">
              Search accounts, manage access and settings
            </span>
          </span>
        </Link>
      </div>
    </div>
  );
}
