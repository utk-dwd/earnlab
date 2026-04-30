"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useDisconnect } from "wagmi";

export function WalletButton() {
  const { disconnect } = useDisconnect();

  return (
    <ConnectButton.Custom>
      {({ account, chain, openConnectModal, mounted }) => {
        // Avoid hydration mismatch — render nothing until mounted
        if (!mounted) return <span aria-hidden="true" />;

        const connected = !!account && !!chain;

        if (!connected) {
          return (
            <button
              onClick={openConnectModal}
              className="px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-600 text-sm hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
            >
              Connect Wallet
            </button>
          );
        }

        return (
          <div className="flex items-center gap-2">
            <span className="hidden sm:inline text-xs font-mono text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 px-2 py-1 rounded">
              {account.displayName}
            </span>
            <button
              onClick={() => disconnect()}
              className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-red-600 text-white text-sm font-medium transition-colors"
            >
              Disconnect Wallet
            </button>
          </div>
        );
      }}
    </ConnectButton.Custom>
  );
}
