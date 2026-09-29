export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center px-6 py-16">
      <p className="font-mono text-xs uppercase tracking-widest text-stone-500">GitHub Automation Bot</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight">
        Rules that act on your issues and pull requests.
      </h1>
      <p className="mt-4 text-stone-600">
        Connect a repository, describe what to look for, and the bot labels or comments on matching issues and
        pull requests, then notifies Slack.
      </p>
    </main>
  );
}
