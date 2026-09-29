import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth/dal";
import type { LoginErrorCode } from "@/server/auth/handlers";

export const metadata: Metadata = { title: "Sign in · GitHub Automation Bot" };

const ERROR_MESSAGES: Record<LoginErrorCode, string> = {
  access_denied: "You cancelled the GitHub authorization. Nothing was changed.",
  invalid_state: "Your sign-in attempt expired or could not be verified. Please try again.",
  oauth_failed: "GitHub sign-in failed. Please try again in a moment.",
  rate_limited: "Too many sign-in attempts from your network. Please wait a few minutes.",
};

function errorMessage(code: string | string[] | undefined): string | null {
  if (typeof code !== "string") return null;
  return code in ERROR_MESSAGES ? ERROR_MESSAGES[code as LoginErrorCode] : null;
}

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  if (await getCurrentUser()) redirect("/dashboard");
  const error = errorMessage((await searchParams).error);

  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center px-6 py-16">
      <p className="font-mono text-xs uppercase tracking-widest text-stone-500">GitHub Automation Bot</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight">
        Rules that act on your issues and pull requests.
      </h1>
      <p className="mt-4 leading-relaxed text-stone-600">
        Connect a repository and describe what to look for. When a matching issue or pull request arrives, the
        bot labels it or comments on it, notifies Slack, and records every step so you can see exactly what
        happened.
      </p>

      {error && (
        <p
          role="alert"
          className="mt-6 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          {error}
        </p>
      )}

      <a
        href="/api/auth/github"
        className="mt-8 inline-flex w-fit items-center gap-2 rounded-md bg-stone-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-stone-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900"
      >
        <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4 fill-current">
          <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
        </svg>
        Sign in with GitHub
      </a>
      <p className="mt-4 text-xs text-stone-500">
        Requested access: your public profile and email, and public repositories (to install a webhook and add
        labels or comments).
      </p>
    </main>
  );
}
