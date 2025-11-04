export default function Home() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-8">
      <main className="flex flex-col items-center gap-8 text-center">
        <h1 className="text-4xl font-bold text-black dark:text-white">
          Welcome to Solana Drift POC
        </h1>
        <p className="max-w-md text-lg text-zinc-600 dark:text-zinc-400">
          This is a proof of concept for Solana Drift isolated trading with Next.js frontend,
          Rust Tokio backend, and NestJS TypeScript backend.
        </p>
        <div className="mt-8 rounded-lg border border-gray-200 dark:border-gray-800 p-6 bg-white dark:bg-zinc-900">
          <h2 className="text-xl font-semibold mb-4 text-black dark:text-white">
            Project Structure
          </h2>
          <ul className="text-left space-y-2 text-zinc-600 dark:text-zinc-400">
            <li>• <strong>Frontend:</strong> Next.js with Solana wallet adapter</li>
            <li>• <strong>Rust Backend:</strong> Tokio-based HTTP server (port 3001)</li>
            <li>• <strong>TS Backend:</strong> NestJS API server (port 3000)</li>
          </ul>
        </div>
      </main>
    </div>
  );
}
