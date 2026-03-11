import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Loft",
  description: "Semantic search for your Google Drive, built for AI tools",
  verification: {
    google: "M3iUarjZvOv8-_LfYSK1MQ7_HxN0Gr2K3NWpXnlDtfM",
  },
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
