import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Omniplex",
  description: "A browser-based, text-interface sci-fi MMO.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Dark-first: the `dark` class is present from the start. Theme-parity
  // rule applies — any future light theme changes color only, not geometry.
  return (
    <html lang="en" className="dark">
      <body>{children}</body>
    </html>
  );
}
