"use client";

import "./globals.css";
import { WagmiProvider } from "wagmi";
import { RainbowKitProvider } from "@rainbow-me/rainbowkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { wagmiConfig } from "../lib/wagmiConfig";
import "@rainbow-me/rainbowkit/styles.css";
import Link from "next/link";
import { usePathname } from "next/navigation";

const queryClient = new QueryClient();

function Nav() {
  const path = usePathname();
  const links = [
    { href: "/", label: "Dashboard" },
    { href: "/marketplace", label: "Marketplace" },
  ];
  return (
    <nav className="sticky top-0 z-50 border-b border-white/10 bg-dark-900/80 backdrop-blur-md">
      <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
        <div className="flex items-center gap-8">
          <Link href="/" className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-brand-green flex items-center justify-center">
              <span className="text-dark-900 font-black text-sm">E</span>
            </div>
            <span className="font-bold text-lg tracking-tight">Earnlab</span>
          </Link>
          <div className="hidden md:flex gap-1">
            {links.map(({ href, label }) => (
              <Link
                key={href}
                href={href}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  path === href
                    ? "bg-white/10 text-white"
                    : "text-white/60 hover:text-white hover:bg-white/5"
                }`}
              >
                {label}
              </Link>
            ))}
          </div>
        </div>
        <ConnectButton chainStatus="icon" showBalance={true} />
      </div>
    </nav>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-dark-900">
        <WagmiProvider config={wagmiConfig}>
          <QueryClientProvider client={queryClient}>
            <RainbowKitProvider>
              <Nav />
              <main className="max-w-7xl mx-auto px-6 py-10">{children}</main>
            </RainbowKitProvider>
          </QueryClientProvider>
        </WagmiProvider>
      </body>
    </html>
  );
}
