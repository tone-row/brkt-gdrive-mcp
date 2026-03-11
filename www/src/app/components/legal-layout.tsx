import Link from "next/link";

export default function LegalLayout({
  title,
  lastUpdated,
  children,
}: {
  title: string;
  lastUpdated: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="px-8 py-4 border-b border-gray-200">
        <Link href="/" className="text-xl font-bold text-gray-900 hover:text-gray-700 transition">
          Loft
        </Link>
      </header>
      <main className="flex-1 max-w-2xl mx-auto px-6 py-12 w-full">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">{title}</h1>
        <p className="text-sm text-gray-400 mb-8">Last updated: {lastUpdated}</p>
        <div className="prose prose-gray max-w-none text-gray-700 space-y-6">
          {children}
        </div>
      </main>
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
