import Image from "next/image";
import { Providers } from "@/app/providers";
import { DashboardNav } from "@/components/dashboard-nav";
import { getCurrentUser } from "@/server/auth/dal";

/**
 * Shared chrome only. This is NOT the security boundary: layouts don't re-render on
 * client navigation, so every page calls requireUser() and every API route checks the
 * session itself.
 */
export default async function DashboardLayout({ children }: LayoutProps<"/dashboard">) {
  const user = await getCurrentUser();

  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-stone-200 bg-white">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-3 px-6 py-3">
          <div className="flex items-center gap-6">
            <span className="font-mono text-xs uppercase tracking-widest text-stone-500">
              GitHub Automation Bot
            </span>
            <DashboardNav />
          </div>
          {user && (
            <div className="flex items-center gap-3">
              {user.avatarUrl && (
                <Image
                  src={user.avatarUrl}
                  alt=""
                  width={28}
                  height={28}
                  unoptimized
                  className="rounded-full border border-stone-200"
                />
              )}
              <span className="text-sm font-medium">{user.githubLogin}</span>
              <form action="/api/auth/logout" method="post">
                <button
                  type="submit"
                  className="rounded-md border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-100 focus-visible:outline-2 focus-visible:outline-stone-900"
                >
                  Sign out
                </button>
              </form>
            </div>
          )}
        </div>
      </header>
      <Providers>
        <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">{children}</main>
      </Providers>
    </div>
  );
}
