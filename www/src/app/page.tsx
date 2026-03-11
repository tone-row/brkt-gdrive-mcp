import Link from "next/link";
import { headers } from "next/headers";
import { auth } from "@/auth";

export default async function Home() {
  const session = await auth.api.getSession({ headers: await headers() });

  return (
    <div className="flex flex-col min-h-screen">
      <div className="flex-1 flex justify-center items-center p-5">
        <div className="text-center max-w-xl">
          <h1 className="text-5xl font-bold mb-4 text-gray-900">Loft</h1>
          <p className="text-2xl text-gray-600 mb-6">
            Semantic search for your Google Drive, built for AI tools
          </p>
          <p className="text-lg text-gray-500 mb-8 leading-relaxed">
            Index your Google Docs, Sheets, PDFs, and more. Search with natural
            language. Use as an MCP server with Claude, Cursor, and other AI
            tools.
          </p>
          <div className="flex gap-4 justify-center">
            {session ? (
              <Link
                href="/dashboard"
                className="px-8 py-3.5 text-lg font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition"
              >
                Go to Dashboard
              </Link>
            ) : (
              <>
                <Link
                  href="/signup"
                  className="px-8 py-3.5 text-lg font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition"
                >
                  Get Started
                </Link>
                <Link
                  href="/login"
                  className="px-8 py-3.5 text-lg font-semibold text-blue-600 bg-white border-2 border-blue-600 rounded-lg hover:bg-blue-50 transition"
                >
                  Sign In
                </Link>
              </>
            )}
          </div>
        </div>
      </div>
      <footer className="py-6 text-center text-sm text-gray-400">
        <Link href="/privacy" className="hover:text-gray-600 transition">
          Privacy Policy
        </Link>
        <span className="mx-2">&middot;</span>
        <Link href="/terms" className="hover:text-gray-600 transition">
          Terms of Use
        </Link>
      </footer>
    </div>
  );
}
