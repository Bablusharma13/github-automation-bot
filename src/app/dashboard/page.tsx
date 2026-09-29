import type { Metadata } from "next";
import Image from "next/image";
import { requireUser } from "@/server/auth/dal";

export const metadata: Metadata = { title: "Dashboard · GitHub Automation Bot" };

export default async function DashboardPage() {
  const user = await requireUser();

  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-stone-200 bg-white">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-3">
          <span className="font-mono text-xs uppercase tracking-widest text-stone-500">
            GitHub Automation Bot
          </span>
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
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl px-6 py-10">
        <h1 className="text-2xl font-semibold tracking-tight">Welcome, {user.name ?? user.githubLogin}</h1>
        <p className="mt-2 text-stone-600">
          You are signed in with GitHub. Repository connection and automation rules are the next step.
        </p>
      </main>
    </div>
  );
}
