import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Google Drive Search",
  description: "Semantic search over your Google Drive documents",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
