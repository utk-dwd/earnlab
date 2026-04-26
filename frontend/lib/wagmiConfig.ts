import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { mainnet, sepolia } from "wagmi/chains";
export const wagmiConfig = getDefaultConfig({
  appName: "Earnlab",
  projectId: process.env.NEXT_PUBLIC_WALLET_CONNECT_ID ?? "",
  chains: [mainnet, sepolia],
  ssr: true,
});
