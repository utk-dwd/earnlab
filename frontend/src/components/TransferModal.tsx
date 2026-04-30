"use client";

import { useState, useEffect } from "react";
import {
  useAccount,
  useBalance,
  useChainId,
  useSwitchChain,
  useSendTransaction,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi";
import { parseEther, parseUnits, isAddress, formatUnits } from "viem";

const APP_WALLET_ADDRESS = process.env.NEXT_PUBLIC_APP_WALLET_ADDRESS as `0x${string}` | undefined;
const AGENT_API_URL = process.env.NEXT_PUBLIC_AGENT_API_URL ?? "http://localhost:3001";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Token {
  symbol:   string;
  name:     string;
  address:  `0x${string}` | "native";
  decimals: number;
  icon:     string;
}

// ── Testnet chain registry ────────────────────────────────────────────────────

const TESTNET_CHAINS = [
  { id: 11155111, name: "Sepolia",          explorerBase: "https://sepolia.etherscan.io/tx" },
  { id: 84532,    name: "Base Sepolia",     explorerBase: "https://sepolia.basescan.org/tx" },
  { id: 11155420, name: "OP Sepolia",       explorerBase: "https://sepolia-optimism.etherscan.io/tx" },
  { id: 421614,   name: "Arb Sepolia",      explorerBase: "https://sepolia.arbiscan.io/tx" },
  { id: 1301,     name: "Unichain Sepolia", explorerBase: "https://unichain-sepolia.blockscout.com/tx" },
] as const;

type TestnetChainId = typeof TESTNET_CHAINS[number]["id"];

// ── Testnet token registry ────────────────────────────────────────────────────

const TESTNET_TOKENS: Record<TestnetChainId, Token[]> = {
  11155111: [
    { symbol: "ETH",  name: "Ether",        address: "native",                                       decimals: 18, icon: "⟠" },
    { symbol: "USDC", name: "USD Coin",      address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", decimals: 6,  icon: "💵" },
    { symbol: "WETH", name: "Wrapped Ether", address: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14", decimals: 18, icon: "⟠" },
    { symbol: "LINK", name: "Chainlink",     address: "0x779877A7B0D9E8603169DdbD7836e478b4624789", decimals: 18, icon: "🔗" },
    { symbol: "DAI",  name: "Dai",           address: "0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357", decimals: 18, icon: "◈" },
  ],
  84532: [
    { symbol: "ETH",  name: "Ether",    address: "native",                                       decimals: 18, icon: "⟠" },
    { symbol: "USDC", name: "USD Coin", address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", decimals: 6,  icon: "💵" },
  ],
  11155420: [
    { symbol: "ETH",  name: "Ether",    address: "native",                                       decimals: 18, icon: "⟠" },
    { symbol: "USDC", name: "USD Coin", address: "0x5fd84259d66Cd46123540766Be93DFE6D43130D7", decimals: 6,  icon: "💵" },
  ],
  421614: [
    { symbol: "ETH",  name: "Ether",    address: "native",                                       decimals: 18, icon: "⟠" },
    { symbol: "USDC", name: "USD Coin", address: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", decimals: 6,  icon: "💵" },
  ],
  1301: [
    { symbol: "ETH",  name: "Ether",    address: "native", decimals: 18, icon: "⟠" },
  ],
};

const ERC20_ABI = [
  {
    type: "function", name: "transfer",
    inputs:  [{ name: "to", type: "address" }, { name: "value", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
] as const;

// ── Live balance display ──────────────────────────────────────────────────────

function TokenBalance({ address, token, chainId }: {
  address: `0x${string}`;
  token:   Token;
  chainId: number;
}) {
  const { data } = useBalance({
    address,
    token:   token.address === "native" ? undefined : token.address,
    chainId,
  });
  if (!data) return <span className="text-gray-400 dark:text-gray-500">—</span>;
  const val = parseFloat(formatUnits(data.value, token.decimals));
  return (
    <span className="font-mono">
      {val < 0.0001 && val > 0 ? "< 0.0001" : val.toFixed(4)} {token.symbol}
    </span>
  );
}

// ── Modal shell ───────────────────────────────────────────────────────────────

function ModalShell({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="relative z-10 w-full max-w-md bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-700 p-6">
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors text-xl leading-none"
        >
          ✕
        </button>
        {children}
      </div>
    </div>
  );
}

// ── Main modal ────────────────────────────────────────────────────────────────
//
// Send tab   = app wallet → connected wallet  (backend signs, no MetaMask)
// Receive tab = connected wallet → app wallet (MetaMask signs)

export function TransferModal({ onClose }: { onClose: () => void }) {
  const { address, isConnected } = useAccount();
  const currentChainId           = useChainId();
  const { switchChainAsync, isPending: isSwitching } = useSwitchChain();

  const defaultChainId: TestnetChainId =
    (TESTNET_CHAINS.find(c => c.id === currentChainId)?.id as TestnetChainId) ?? 11155111;

  const [tab,           setTab]           = useState<"send" | "receive">("send");
  const [chainId,       setChainId]       = useState<TestnetChainId>(defaultChainId);
  const [selectedToken, setSelectedToken] = useState<Token>(TESTNET_TOKENS[defaultChainId][0]);

  // ── Send tab state (app wallet → connected wallet, backend signs) ─────────
  // "To" defaults to the connected wallet address
  const [sendTo,      setSendTo]      = useState<string>("");
  const [sendAmount,  setSendAmount]  = useState("");
  const [sendTxHash,  setSendTxHash]  = useState<string | null>(null);
  const [sendError,   setSendError]   = useState<string | null>(null);
  const [sendLoading, setSendLoading] = useState(false);

  // ── Receive tab state (connected wallet → app wallet, MetaMask signs) ─────
  // "To" defaults to the app wallet address
  const [recvTo,     setRecvTo]     = useState<string>(APP_WALLET_ADDRESS ?? "");
  const [recvAmount, setRecvAmount] = useState("");

  // Populate Send "To" with the connected wallet once it resolves
  useEffect(() => {
    if (address && !sendTo) setSendTo(address);
  }, [address]);
  const [recvTxHash, setRecvTxHash] = useState<`0x${string}` | undefined>(undefined);
  const [recvError,  setRecvError]  = useState<string | null>(null);

  const tokens    = TESTNET_TOKENS[chainId];
  const chainMeta = TESTNET_CHAINS.find(c => c.id === chainId)!;

  // ── Connected wallet balance (used in Receive tab) ────────────────────────
  const { data: connectedBalance } = useBalance({
    address,
    token:   selectedToken.address === "native" ? undefined : selectedToken.address,
    chainId,
  });

  // ── Wagmi hooks (Receive tab: connected wallet signs via MetaMask) ─────────
  const { sendTransactionAsync, isPending: isRecvSendingNative } = useSendTransaction();
  const { writeContractAsync,   isPending: isRecvSendingToken  } = useWriteContract();
  const {
    isLoading: isRecvTxPending,
    isSuccess: isRecvTxSuccess,
  } = useWaitForTransactionReceipt({ hash: recvTxHash });

  const isBusy = isSwitching || sendLoading || isRecvSendingNative || isRecvSendingToken || isRecvTxPending;

  // ── Chain switch ──────────────────────────────────────────────────────────
  async function handleChainChange(newId: number) {
    const id  = newId as TestnetChainId;
    const tks = TESTNET_TOKENS[id];
    setChainId(id);
    setSelectedToken(tks[0]);
    setSendAmount(""); setSendTxHash(null); setSendError(null);
    setRecvAmount(""); setRecvTxHash(undefined); setRecvError(null);
    try { await switchChainAsync({ chainId: id }); } catch { /* user dismissed */ }
  }

  // ── Token change ──────────────────────────────────────────────────────────
  function handleTokenChange(symbol: string) {
    const t = tokens.find(t => t.symbol === symbol);
    if (!t) return;
    setSelectedToken(t);
    setSendAmount(""); setSendTxHash(null); setSendError(null);
    setRecvAmount(""); setRecvTxHash(undefined); setRecvError(null);
  }

  // ── MAX (Receive tab: uses connected wallet balance) ─────────────────────
  function handleRecvMax() {
    if (!connectedBalance) return;
    const val = parseFloat(formatUnits(connectedBalance.value, selectedToken.decimals));
    const adj = selectedToken.address === "native" ? Math.max(val - 0.001, 0) : val;
    setRecvAmount(adj > 0 ? adj.toFixed(6) : "0");
  }

  // ── Send (app wallet → connected wallet via backend) ──────────────────────
  async function handleSend() {
    if (!isAddress(sendTo) || !sendAmount) return;
    setSendLoading(true);
    setSendError(null);
    setSendTxHash(null);
    try {
      const res = await fetch(`${AGENT_API_URL}/wallet/send`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chainId,
          tokenAddress: selectedToken.address === "native" ? null : selectedToken.address,
          decimals:     selectedToken.decimals,
          to:           sendTo,
          amount:       sendAmount,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setSendError(data.error ?? "Transfer failed");
      } else {
        setSendTxHash(data.txHash);
      }
    } catch (e: any) {
      setSendError(e?.message ?? "Network error");
    } finally {
      setSendLoading(false);
    }
  }

  // ── Receive (connected wallet → app wallet, MetaMask popup) ───────────────
  async function handleReceive() {
    if (!address || !isAddress(recvTo) || !recvAmount) return;
    setRecvError(null);
    setRecvTxHash(undefined);
    try {
      let hash: `0x${string}`;
      if (selectedToken.address === "native") {
        hash = await sendTransactionAsync({
          to:      recvTo as `0x${string}`,
          value:   parseEther(recvAmount),
          chainId,
        });
      } else {
        hash = await writeContractAsync({
          address:      selectedToken.address,
          abi:          ERC20_ABI,
          functionName: "transfer",
          args:         [recvTo as `0x${string}`, parseUnits(recvAmount, selectedToken.decimals)],
          chainId,
        });
      }
      setRecvTxHash(hash);
    } catch (e: any) {
      const raw = e?.shortMessage ?? e?.message ?? "Transaction failed";
      setRecvError(raw.length > 150 ? raw.slice(0, 150) + "…" : raw);
    }
  }

  // ── Not connected ─────────────────────────────────────────────────────────
  if (!isConnected) {
    return (
      <ModalShell onClose={onClose}>
        <div className="text-center py-10 space-y-3">
          <p className="text-3xl">🔌</p>
          <p className="text-gray-700 dark:text-gray-300 font-medium">Connect your wallet to transfer funds</p>
          <p className="text-sm text-gray-500 dark:text-gray-400">Use the Connect Wallet button in the top-right corner.</p>
        </div>
      </ModalShell>
    );
  }

  // ── Derived validation ────────────────────────────────────────────────────
  const sendToValid     = sendTo.length > 0 && isAddress(sendTo);
  const sendAmountValid = sendAmount.length > 0 && !isNaN(parseFloat(sendAmount)) && parseFloat(sendAmount) > 0;
  const canSend         = sendToValid && sendAmountValid && !isBusy && !!APP_WALLET_ADDRESS;

  const recvToValid     = recvTo.length > 0 && isAddress(recvTo);
  const recvAmountValid = recvAmount.length > 0 && !isNaN(parseFloat(recvAmount)) && parseFloat(recvAmount) > 0;
  const canReceive      = recvToValid && recvAmountValid && !isBusy;

  return (
    <ModalShell onClose={onClose}>
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">💸 Transfer Funds</h2>
        <span className="text-xs font-mono text-gray-400 dark:text-gray-500 bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded">
          {address.slice(0, 6)}…{address.slice(-4)}
        </span>
      </div>

      {/* Network selector */}
      <div className="mb-4">
        <label className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-1.5 block">
          Testnet Network
        </label>
        <select
          value={chainId}
          onChange={e => handleChainChange(Number(e.target.value))}
          disabled={isBusy}
          className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
        >
          {TESTNET_CHAINS.map(c => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        {isSwitching && (
          <p className="text-xs text-amber-500 dark:text-amber-400 mt-1 animate-pulse">Switching network in wallet…</p>
        )}
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 mb-5 bg-gray-100 dark:bg-gray-800 rounded-lg p-1">
        {(["send", "receive"] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 py-1.5 rounded-md text-sm font-semibold transition-colors ${
              tab === t
                ? "bg-white dark:bg-gray-700 text-indigo-700 dark:text-indigo-300 shadow-sm"
                : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
            }`}
          >
            {t === "send" ? "⬆ Send" : "⬇ Receive"}
          </button>
        ))}
      </div>

      {/* ── Send tab: app wallet → connected wallet (backend signs) ── */}
      {tab === "send" && (
        <div className="space-y-4">

          {/* From: app wallet (read-only) */}
          <div className="rounded-lg bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-700 px-3 py-2.5">
            <p className="text-xs text-indigo-500 dark:text-indigo-400 mb-0.5">From (app wallet)</p>
            {APP_WALLET_ADDRESS
              ? <p className="font-mono text-sm text-gray-800 dark:text-gray-200 break-all">{APP_WALLET_ADDRESS}</p>
              : <p className="text-xs text-red-500">NEXT_PUBLIC_APP_WALLET_ADDRESS not set in .env</p>
            }
          </div>

          {/* Token + app wallet balance */}
          <div>
            <label className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-1.5 block">
              Token
            </label>
            <select
              value={selectedToken.symbol}
              onChange={e => handleTokenChange(e.target.value)}
              disabled={isBusy}
              className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
            >
              {tokens.map(t => (
                <option key={t.symbol} value={t.symbol}>{t.icon} {t.symbol} — {t.name}</option>
              ))}
            </select>
            {APP_WALLET_ADDRESS && (
              <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                App wallet balance: <TokenBalance address={APP_WALLET_ADDRESS} token={selectedToken} chainId={chainId} />
              </p>
            )}
          </div>

          {/* To: connected wallet (pre-filled, editable) */}
          <div>
            <label className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-1.5 block">
              To Address
            </label>
            <input
              type="text"
              value={sendTo}
              onChange={e => setSendTo(e.target.value)}
              disabled={isBusy}
              spellCheck={false}
              className={`w-full rounded-lg border px-3 py-2 text-sm font-mono bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50 transition-colors ${
                sendTo.length > 0 && !sendToValid
                  ? "border-red-400 dark:border-red-600"
                  : "border-gray-200 dark:border-gray-700"
              }`}
            />
            {sendTo.length > 0 && !sendToValid && (
              <p className="text-xs text-red-500 mt-1">Not a valid address</p>
            )}
            {address && sendTo !== address && (
              <button
                onClick={() => setSendTo(address)}
                className="text-xs text-indigo-600 dark:text-indigo-400 mt-1 underline"
              >
                Use connected wallet
              </button>
            )}
          </div>

          {/* Amount */}
          <div>
            <label className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-1.5 block">
              Amount
            </label>
            <input
              type="number"
              placeholder="0.00"
              value={sendAmount}
              onChange={e => setSendAmount(e.target.value)}
              disabled={isBusy}
              min="0"
              step="any"
              className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
            />
          </div>

          {/* Send button */}
          <button
            onClick={handleSend}
            disabled={!canSend}
            className="w-full py-2.5 rounded-xl font-semibold text-sm transition-colors bg-indigo-600 hover:bg-indigo-700 text-white disabled:bg-gray-200 dark:disabled:bg-gray-700 disabled:text-gray-400 dark:disabled:text-gray-500 disabled:cursor-not-allowed"
          >
            {sendLoading ? "⏳ Sending…" : `Send ${selectedToken.symbol} to Your Wallet`}
          </button>

          {sendTxHash && (
            <div className="rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 px-3 py-2.5 text-xs text-green-700 dark:text-green-400">
              <p className="font-semibold mb-0.5">✓ Transfer sent</p>
              <a href={`${chainMeta.explorerBase}/${sendTxHash}`} target="_blank" rel="noopener noreferrer"
                className="underline font-medium break-all">
                View on explorer →
              </a>
            </div>
          )}

          {sendError && (
            <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 px-3 py-2.5 text-xs text-red-700 dark:text-red-400">
              <p className="font-semibold mb-0.5">Transfer failed</p>
              <p className="leading-relaxed">{sendError}</p>
            </div>
          )}
        </div>
      )}

      {/* ── Receive tab: connected wallet → app wallet (MetaMask signs) ── */}
      {tab === "receive" && (
        <div className="space-y-4">

          {/* From: connected wallet (read-only) */}
          <div className="rounded-lg bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 px-3 py-2.5">
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-0.5">From (your wallet)</p>
            <p className="font-mono text-sm text-gray-800 dark:text-gray-200 truncate">{address}</p>
          </div>

          {/* Token + connected wallet balance */}
          <div>
            <label className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-1.5 block">
              Token
            </label>
            <select
              value={selectedToken.symbol}
              onChange={e => handleTokenChange(e.target.value)}
              disabled={isBusy}
              className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
            >
              {tokens.map(t => (
                <option key={t.symbol} value={t.symbol}>{t.icon} {t.symbol} — {t.name}</option>
              ))}
            </select>
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
              Balance: <TokenBalance address={address} token={selectedToken} chainId={chainId} />
            </p>
          </div>

          {/* To: app wallet (pre-filled, editable) */}
          <div>
            <label className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-1.5 block">
              To Address (app wallet)
            </label>
            <input
              type="text"
              value={recvTo}
              onChange={e => setRecvTo(e.target.value)}
              disabled={isBusy}
              spellCheck={false}
              className={`w-full rounded-lg border px-3 py-2 text-sm font-mono bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50 transition-colors ${
                recvTo.length > 0 && !recvToValid
                  ? "border-red-400 dark:border-red-600"
                  : "border-gray-200 dark:border-gray-700"
              }`}
            />
            {recvTo.length > 0 && !recvToValid && (
              <p className="text-xs text-red-500 mt-1">Not a valid address</p>
            )}
            {APP_WALLET_ADDRESS && recvTo !== APP_WALLET_ADDRESS && (
              <button
                onClick={() => setRecvTo(APP_WALLET_ADDRESS)}
                className="text-xs text-indigo-600 dark:text-indigo-400 mt-1 underline"
              >
                Use app wallet address
              </button>
            )}
          </div>

          {/* Amount */}
          <div>
            <label className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-1.5 block">
              Amount
            </label>
            <div className="flex gap-2">
              <input
                type="number"
                placeholder="0.00"
                value={recvAmount}
                onChange={e => setRecvAmount(e.target.value)}
                disabled={isBusy}
                min="0"
                step="any"
                className="flex-1 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
              />
              <button
                onClick={handleRecvMax}
                disabled={isBusy || !connectedBalance}
                className="px-3 py-2 text-xs font-bold rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-40 transition-colors"
              >
                MAX
              </button>
            </div>
          </div>

          {/* Receive button — triggers MetaMask confirmation popup */}
          <button
            onClick={handleReceive}
            disabled={!canReceive}
            className="w-full py-2.5 rounded-xl font-semibold text-sm transition-colors bg-indigo-600 hover:bg-indigo-700 text-white disabled:bg-gray-200 dark:disabled:bg-gray-700 disabled:text-gray-400 dark:disabled:text-gray-500 disabled:cursor-not-allowed"
          >
            {isRecvSendingNative || isRecvSendingToken
              ? "Confirm in wallet…"
              : isRecvTxPending
              ? "⏳ Waiting for confirmation…"
              : `Send ${selectedToken.symbol} to App Wallet`}
          </button>

          {isRecvTxSuccess && recvTxHash && (
            <div className="rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 px-3 py-2.5 text-xs text-green-700 dark:text-green-400">
              <p className="font-semibold mb-0.5">✓ Transaction confirmed</p>
              <a href={`${chainMeta.explorerBase}/${recvTxHash}`} target="_blank" rel="noopener noreferrer"
                className="underline font-medium break-all">
                View on explorer →
              </a>
            </div>
          )}

          {recvError && (
            <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 px-3 py-2.5 text-xs text-red-700 dark:text-red-400">
              <p className="font-semibold mb-0.5">Transaction failed</p>
              <p className="leading-relaxed">{recvError}</p>
            </div>
          )}
        </div>
      )}
    </ModalShell>
  );
}
