import type { Metadata } from "next";
import { RepositoriesManager } from "@/components/repositories-manager";
import { requireUser } from "@/server/auth/dal";

export const metadata: Metadata = { title: "Repositories · GitHub Automation Bot" };

export default async function RepositoriesPage() {
  await requireUser();
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Repositories</h1>
      <p className="mt-2 max-w-2xl text-stone-600">
        Connecting a repository installs a webhook for issue and pull request events. You need admin access,
        and the repository must be public.
      </p>
      <RepositoriesManager />
    </div>
  );
}
