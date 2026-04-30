import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import {
  mainnet, base, optimism, arbitrum, unichain,
  sepolia, baseSepolia, optimismSepolia, arbitrumSepolia, unichainSepolia,
} from "wagmi/chains";

export const wagmiConfig = getDefaultConfig({
  appName: "EarnYld",
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "earnYld_placeholder",
  chains: [
    mainnet, base, optimism, arbitrum, unichain,
    sepolia, baseSepolia, optimismSepolia, arbitrumSepolia, unichainSepolia,
  ],
  ssr: true,
});
