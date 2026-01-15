import Link from "next/link";

export default function Home() {
  return (
    <div className="flex justify-center items-center min-h-screen p-5">
      <div className="text-center max-w-xl">
        <h1 className="text-5xl font-bold mb-4 text-gray-900">
          Google Drive Search
        </h1>
        <p className="text-2xl text-gray-600 mb-6">
          Semantic search over your Google Docs, powered by AI
        </p>
        <p className="text-lg text-gray-500 mb-8 leading-relaxed">
          Connect your Google Drive and search through all your documents using
          natural language. Find what you need, fast.
        </p>
        <div className="flex gap-4 justify-center">
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
        </div>
      </div>
    </div>
  );
}
