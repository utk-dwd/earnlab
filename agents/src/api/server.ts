import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import path from "path";
import yaml from "js-yaml";
import fs from "fs";
import type { ReporterAgent }    from "../ReporterAgent";
import type { PortfolioManager } from "../PortfolioManager";
import type { ReflectionAgent }  from "../llm/ReflectionAgent";
import { SlippageGuard } from "../calculator/SlippageGuard";
import { getModel, setModel, AVAILABLE_MODELS } from "../llm/LLMConfig";

// ── Swap registry (Uniswap V3 testnets + 0G JAINE DEX) ───────────────────────

const SWAP_REGISTRY: Record<number, {
  name:         string;
  dexName:      string;
  router:       `0x${string}`;
  quoter:       `0x${string}`;
  weth:         `0x${string}`;
  rpc:          string;
  explorerBase: string;
  tokens:       Array<{ symbol: string; name: string; address: `0x${string}`; decimals: number }>;
}> = {
  11155111: {
    name: "Sepolia", dexName: "Uniswap V3",
    router: "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E",
    quoter: "0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3",
    weth:   "0xfFf9976782d46CC05630D1f6ebab18b2324d6B14",
    rpc:    process.env.SEPOLIA_RPC_URL        ?? "https://rpc.sepolia.org",
    explorerBase: "https://sepolia.etherscan.io/tx",
    tokens: [
      { symbol: "WETH", name: "Wrapped Ether",  address: "0xfFf9976782d46CC05630D1f6ebab18b2324d6B14", decimals: 18 },
      { symbol: "USDC", name: "USD Coin",        address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", decimals: 6  },
      { symbol: "LINK", name: "Chainlink",       address: "0x779877A7B0D9E8603169DdbD7836e478b4624789", decimals: 18 },
      { symbol: "DAI",  name: "Dai",             address: "0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357", decimals: 18 },
    ],
  },
  84532: {
    name: "Base Sepolia", dexName: "Uniswap V3",
    router: "0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4",
    quoter: "0xC5290058841028F1614F3A6F0F5816cAd0df5E27",
    weth:   "0x4200000000000000000000000000000000000006",
    rpc:    process.env.BASE_SEPOLIA_RPC_URL   ?? "https://sepolia.base.org",
    explorerBase: "https://sepolia.basescan.org/tx",
    tokens: [
      { symbol: "WETH", name: "Wrapped Ether", address: "0x4200000000000000000000000000000000000006", decimals: 18 },
      { symbol: "USDC", name: "USD Coin",       address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", decimals: 6  },
    ],
  },
  11155420: {
    name: "OP Sepolia", dexName: "Uniswap V3",
    router: "0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4",
    quoter: "0xC5290058841028F1614F3A6F0F5816cAd0df5E27",
    weth:   "0x4200000000000000000000000000000000000006",
    rpc:    process.env.OP_SEPOLIA_RPC_URL     ?? "https://sepolia.optimism.io",
    explorerBase: "https://sepolia-optimism.etherscan.io/tx",
    tokens: [
      { symbol: "WETH", name: "Wrapped Ether", address: "0x4200000000000000000000000000000000000006", decimals: 18 },
      { symbol: "USDC", name: "USD Coin",       address: "0x5fd84259d66Cd46123540766Be93DFE6D43130D7", decimals: 6  },
    ],
  },
  421614: {
    name: "Arb Sepolia", dexName: "Uniswap V3",
    router: "0x101F443B4d1b059569D643917553c771E1b9663E",
    quoter: "0x2779a0CC1c3e0E44D2542EC3e79e3864Ae93Ef0B",
    weth:   "0x980B62Da83eFf3D4576C647993b0c1D7faf17c73",
    rpc:    process.env.ARB_SEPOLIA_RPC_URL    ?? "https://sepolia-rollup.arbitrum.io/rpc",
    explorerBase: "https://sepolia.arbiscan.io/tx",
    tokens: [
      { symbol: "WETH", name: "Wrapped Ether", address: "0x980B62Da83eFf3D4576C647993b0c1D7faf17c73", decimals: 18 },
      { symbol: "USDC", name: "USD Coin",       address: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", decimals: 6  },
    ],
  },
  1301: {
    name: "Unichain Sepolia", dexName: "Uniswap V3",
    router: "0xd1AAE39293221B77B0C71fBD6dCb7Ea29Bb5B166",
    quoter: "0x6Dd37329A1A225a6Fca658265D460423DCafBF89",
    weth:   "0x4200000000000000000000000000000000000006",
    rpc:    process.env.UNICHAIN_SEPOLIA_RPC_URL ?? "https://sepolia.unichain.org",
    explorerBase: "https://unichain-sepolia.blockscout.com/tx",
    tokens: [
      { symbol: "WETH", name: "Wrapped Ether", address: "0x4200000000000000000000000000000000000006", decimals: 18 },
    ],
  },
  16661: {
    name: "0G Network", dexName: "JAINE DEX (0G)",
    router: "0x18cCa38E51c4C339A6BD6e174025f08360FEEf30",
    quoter: "0x23b55293b7F06F6c332a0dDA3D88d8921218425B",
    weth:   "0x1Cd0690fF9a693f5EF2dD976660a8dAFc81A109c",
    rpc:    "https://evmrpc.0g.ai",
    explorerBase: "https://chainscan.0g.ai/tx",
    tokens: [
      { symbol: "WKOG", name: "Wrapped KOG", address: "0x1Cd0690fF9a693f5EF2dD976660a8dAFc81A109c", decimals: 18 },
    ],
  },
};

const QUOTER_V2_ABI = [
  {
    name: "quoteExactInputSingle", type: "function", stateMutability: "nonpayable",
    inputs: [{
      name: "params", type: "tuple",
      components: [
        { name: "tokenIn",           type: "address" },
        { name: "tokenOut",          type: "address" },
        { name: "amountIn",          type: "uint256" },
        { name: "fee",               type: "uint24"  },
        { name: "sqrtPriceLimitX96", type: "uint160" },
      ],
    }],
    outputs: [
      { name: "amountOut",               type: "uint256" },
      { name: "sqrtPriceX96After",       type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32"  },
      { name: "gasEstimate",             type: "uint256" },
    ],
  },
] as const;

const SWAP_ROUTER_ABI = [
  {
    name: "exactInputSingle", type: "function", stateMutability: "payable",
    inputs: [{
      name: "params", type: "tuple",
      components: [
        { name: "tokenIn",           type: "address" },
        { name: "tokenOut",          type: "address" },
        { name: "fee",               type: "uint24"  },
        { name: "recipient",         type: "address" },
        { name: "amountIn",          type: "uint256" },
        { name: "amountOutMinimum",  type: "uint256" },
        { name: "sqrtPriceLimitX96", type: "uint160" },
      ],
    }],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

const ERC20_SWAP_ABI = [
  {
    name: "allowance", type: "function", stateMutability: "view",
    inputs:  [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "approve", type: "function", stateMutability: "nonpayable",
    inputs:  [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

function buildSwapChain(chainId: number, rpcUrl: string) {
  const META: Record<number, { name: string; symbol: string }> = {
    11155111: { name: "Sepolia",          symbol: "ETH"  },
    84532:    { name: "Base Sepolia",     symbol: "ETH"  },
    11155420: { name: "OP Sepolia",       symbol: "ETH"  },
    421614:   { name: "Arb Sepolia",      symbol: "ETH"  },
    1301:     { name: "Unichain Sepolia", symbol: "ETH"  },
    16661:    { name: "0G Network",       symbol: "A0GI" },
  };
  const m = META[chainId] ?? { name: `Chain ${chainId}`, symbol: "ETH" };
  return {
    id:             chainId,
    name:           m.name,
    nativeCurrency: { name: m.name, symbol: m.symbol, decimals: 18 },
    rpcUrls:        { default: { http: [rpcUrl] } },
  };
}

export function createApiServer(
  agent:      ReporterAgent,
  portfolio:  PortfolioManager,
  reflection: ReflectionAgent,
): express.Application {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // ── Root redirect ───────────────────────────────────────────────────────────
  app.get("/", (_req, res) => {
    res.json({
      name: "EarnYld Yield Hunter API",
      endpoints: ["/yields", "/positions", "/executions", "/stats", "/chains", "/health", "/openapi.json"],
      docs: "http://localhost:3000/docs",
    });
  });

  // ── Serve OpenAPI spec as JSON ──────────────────────────────────────────────
  app.get("/openapi.json", (_req, res) => {
    const specPath = path.join(__dirname, "openapi.yaml");
    try {
      const doc = yaml.load(fs.readFileSync(specPath, "utf-8"));
      res.json(doc);
    } catch {
      res.status(500).json({ error: "Could not load OpenAPI spec" });
    }
  });

  // ── GET /yields ─────────────────────────────────────────────────────────────
  /**
   * Returns ranked yield opportunities across all testnets.
   * Query params:
   *   ?chainId=11155111   filter to one chain
   *   ?minAPY=5           minimum displayAPY
   *   ?limit=20
   */
  app.get("/yields", (req: Request, res: Response) => {
    let results = agent.getLatest();

    if (req.query.network) {
      results = results.filter((r) => r.network === req.query.network);
    }
    if (req.query.chainId) {
      const cid = Number(req.query.chainId);
      results = results.filter((r) => r.chainId === cid);
    }
    if (req.query.minAPY) {
      const min = Number(req.query.minAPY);
      results = results.filter((r) => r.displayAPY >= min);
    }
    const limit = Math.min(Number(req.query.limit ?? 20), 100);
    res.json({ count: results.length, data: results.slice(0, limit) });
  });

  // ── GET /yields/:poolId ─────────────────────────────────────────────────────
  app.get("/yields/:poolId", (req: Request, res: Response) => {
    const opp = agent.getLatest().find((r) => r.poolId === req.params.poolId);
    if (!opp) return res.status(404).json({ error: "Pool not found in latest scan" });
    res.json(opp);
  });

  // ── GET /positions ──────────────────────────────────────────────────────────
  /**
   * Returns open positions with live PnL.
   */
  app.get("/positions", (_req: Request, res: Response) => {
    res.json({ data: agent.getPositions() });
  });

  // ── GET /positions/all ──────────────────────────────────────────────────────
  app.get("/positions/all", (req: Request, res: Response) => {
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    res.json({ data: agent.getAllPositions().slice(0, limit) });
  });

  // ── GET /executions ─────────────────────────────────────────────────────────
  /**
   * Query params:
   *   ?chainId=   ?action=add_liquidity|swap|...  ?status=confirmed  ?limit=50
   */
  app.get("/executions", (req: Request, res: Response) => {
    const executions = agent.getHistory({
      chainId: req.query.chainId ? Number(req.query.chainId) : undefined,
      action:  req.query.action  as any,
      status:  req.query.status  as any,
      limit:   Math.min(Number(req.query.limit ?? 50), 200),
      offset:  Number(req.query.offset ?? 0),
    });
    res.json({ count: executions.length, data: executions });
  });

  // ── GET /stats ───────────────────────────────────────────────────────────────
  app.get("/stats", (_req: Request, res: Response) => {
    res.json(agent.getStats());
  });

  // ── GET /chains ──────────────────────────────────────────────────────────────
  app.get("/chains", (_req: Request, res: Response) => {
    const { SUPPORTED_CHAINS } = require("../config/chains");
    res.json(
      SUPPORTED_CHAINS.map((c: any) => ({
        chainId:   c.chainId,
        name:      c.name,
        blockTime: c.blockTime,
        contracts: c.contracts,
      }))
    );
  });

  // ── POST /slippage/check ─────────────────────────────────────────────────────
  /**
   * Simulate a swap and check if price impact is within tolerance.
   * Body: { chainId, poolKey, zeroForOne, amountIn, maxSlippageBps, inputTokenPriceUsd, inputTokenDecimals }
   */
  app.post("/slippage/check", async (req: Request, res: Response) => {
    try {
      const {
        chainId, poolKey, zeroForOne, amountIn,
        maxSlippageBps, inputTokenPriceUsd, inputTokenDecimals,
      } = req.body;

      if (!chainId || !poolKey || amountIn == null) {
        return res.status(400).json({ error: "Missing required fields: chainId, poolKey, amountIn" });
      }

      const result = await agent.checkSlippage({
        chainId,
        poolKey,
        zeroForOne:           Boolean(zeroForOne),
        amountIn:             BigInt(amountIn),
        maxSlippageBps:       Number(maxSlippageBps ?? 50),
        inputTokenPriceUsd:   Number(inputTokenPriceUsd ?? 0),
        inputTokenDecimals:   Number(inputTokenDecimals ?? 18),
      });

      res.json({
        ...result,
        quotedOut:         result.quotedOut.toString(),
        sqrtPriceLimitX96: result.sqrtPriceLimitX96.toString(),
        gasEstimate:       result.gasEstimate.toString(),
        minAmountOut:      SlippageGuard.minAmountOut(result.quotedOut, maxSlippageBps ?? 50).toString(),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /portfolio ───────────────────────────────────────────────────────────
  app.get("/portfolio", (_req: Request, res: Response) => {
    res.json(portfolio.getSummary());
  });

  app.get("/portfolio/positions", (_req: Request, res: Response) => {
    res.json({ data: portfolio.getPositions() });
  });

  app.get("/portfolio/trades", (_req: Request, res: Response) => {
    res.json({ count: portfolio.getTrades().length, data: portfolio.getTrades() });
  });

  // ── GET /portfolio/decisions ──────────────────────────────────────────────────
  app.get("/portfolio/decisions", (req: Request, res: Response) => {
    const limit = Math.min(Number(req.query.limit ?? 20), 50);
    res.json({ data: portfolio.getDecisionHistory(limit) });
  });

  // ── GET /settings ─────────────────────────────────────────────────────────────
  app.get("/settings", (_req: Request, res: Response) => {
    res.json({ autonomousMode: portfolio.isAutonomousMode() });
  });

  // ── POST /settings ────────────────────────────────────────────────────────────
  app.post("/settings", (req: Request, res: Response) => {
    const { autonomousMode } = req.body;
    if (typeof autonomousMode !== "boolean") {
      return res.status(400).json({ error: "autonomousMode must be a boolean" });
    }
    portfolio.setAutonomousMode(autonomousMode);
    res.json({ autonomousMode: portfolio.isAutonomousMode() });
  });

  // ── GET /settings/llm ─────────────────────────────────────────────────────────
  app.get("/settings/llm", (_req: Request, res: Response) => {
    res.json({ model: getModel(), availableModels: AVAILABLE_MODELS });
  });

  // ── POST /settings/llm ────────────────────────────────────────────────────────
  app.post("/settings/llm", (req: Request, res: Response) => {
    const { model } = req.body;
    if (typeof model !== "string" || !model.trim()) {
      return res.status(400).json({ error: "model must be a non-empty string" });
    }
    setModel(model.trim());
    console.log(`[API] LLM model changed to: ${getModel()}`);
    res.json({ model: getModel() });
  });

  // ── GET /pending-actions ──────────────────────────────────────────────────────
  app.get("/pending-actions", (_req: Request, res: Response) => {
    const actions = portfolio.getPendingActions();
    res.json({ count: actions.length, data: actions });
  });

  // ── POST /pending-actions/:id/approve ─────────────────────────────────────────
  app.post("/pending-actions/:id/approve", async (req: Request, res: Response) => {
    const result = await portfolio.approvePendingAction(req.params.id);
    if (!result.ok) {
      const status = result.staleReason ? 409 : result.executionFailed ? 422 : 404;
      return res.status(status).json(result);
    }
    res.json(result);
  });

  // ── POST /pending-actions/:id/reject ──────────────────────────────────────────
  app.post("/pending-actions/:id/reject", (req: Request, res: Response) => {
    const result = portfolio.rejectPendingAction(req.params.id);
    if (!result.ok) return res.status(404).json(result);
    res.json(result);
  });

  // ── GET /reflections ─────────────────────────────────────────────────────────
  app.get("/reflections", (_req: Request, res: Response) => {
    const store = reflection.getStore();
    res.json({
      enabled:  reflection.isEnabled(),
      recent:   store.getRecent(),
      archived: store.getArchived(50),
    });
  });

  // ── GET /reflections/stream (SSE) ─────────────────────────────────────────
  app.get("/reflections/stream", (req: Request, res: Response) => {
    res.writeHead(200, {
      "Content-Type":                "text/event-stream",
      "Cache-Control":               "no-cache",
      "Connection":                  "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "X-Accel-Buffering":           "no", // disable nginx buffering if present
    });

    const send = (data: object) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // Immediately hydrate the client with stored history
    const store = reflection.getStore();
    send({ type: "history", recent: store.getRecent(), archived: store.getArchived(50), enabled: reflection.isEnabled() });

    // Subscribe to live reflection events
    const unsub = reflection.onEvent((evt) => send(evt));

    // Keepalive comment every 25s to prevent proxies from closing the connection
    const ping = setInterval(() => res.write(": ka\n\n"), 25_000);

    req.on("close", () => {
      clearInterval(ping);
      unsub();
    });
  });

  // ── POST /wallet/send ─────────────────────────────────────────────────────
  // App wallet signs and broadcasts a transfer to the given recipient.
  // Body: { chainId, tokenAddress?, decimals?, to, amount }
  app.post("/wallet/send", async (req: Request, res: Response) => {
    try {
      const { createWalletClient, http, parseEther, parseUnits, isAddress } = await import("viem");
      const { privateKeyToAccount } = await import("viem/accounts");
      const {
        sepolia, baseSepolia, optimismSepolia, arbitrumSepolia,
      } = await import("viem/chains");

      const { chainId, tokenAddress, decimals, to, amount } = req.body;

      if (!chainId || !to || !amount) {
        return res.status(400).json({ error: "Missing required fields: chainId, to, amount" });
      }
      if (!isAddress(to)) {
        return res.status(400).json({ error: "Invalid recipient address" });
      }

      const privateKey = process.env.APP_WALLET_PRIVATE_KEY as `0x${string}` | undefined;
      if (!privateKey) {
        return res.status(500).json({ error: "App wallet not configured (APP_WALLET_PRIVATE_KEY missing)" });
      }

      const RPC_URLS: Record<number, string> = {
        11155111: process.env.SEPOLIA_RPC_URL        ?? "https://rpc.sepolia.org",
        84532:    process.env.BASE_SEPOLIA_RPC_URL   ?? "https://sepolia.base.org",
        11155420: process.env.OP_SEPOLIA_RPC_URL     ?? "https://sepolia.optimism.io",
        421614:   process.env.ARB_SEPOLIA_RPC_URL    ?? "https://sepolia-rollup.arbitrum.io/rpc",
        1301:     process.env.UNICHAIN_SEPOLIA_RPC_URL ?? "https://sepolia.unichain.org",
      };

      const unichainSepolia = {
        id: 1301,
        name: "Unichain Sepolia",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [RPC_URLS[1301]] } },
      } as const;

      const CHAINS: Record<number, any> = {
        11155111: sepolia,
        84532:    baseSepolia,
        11155420: optimismSepolia,
        421614:   arbitrumSepolia,
        1301:     unichainSepolia,
      };

      const cid   = Number(chainId);
      const chain = CHAINS[cid];
      const rpc   = RPC_URLS[cid];
      if (!chain || !rpc) {
        return res.status(400).json({ error: `Unsupported chainId: ${chainId}` });
      }

      const account = privateKeyToAccount(privateKey);
      const client  = createWalletClient({ account, chain, transport: http(rpc) });

      let hash: `0x${string}`;

      if (!tokenAddress || tokenAddress === "native") {
        hash = await client.sendTransaction({
          to:    to as `0x${string}`,
          value: parseEther(String(amount)),
          chain,
        });
      } else {
        const ERC20_ABI = [
          {
            type: "function", name: "transfer",
            inputs: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }],
            outputs: [{ name: "", type: "bool" }],
            stateMutability: "nonpayable",
          },
        ] as const;
        hash = await client.writeContract({
          address:      tokenAddress as `0x${string}`,
          abi:          ERC20_ABI,
          functionName: "transfer",
          args:         [to as `0x${string}`, parseUnits(String(amount), Number(decimals ?? 18))],
          chain,
        });
      }

      res.json({ ok: true, txHash: hash, chainId: cid });
    } catch (err: any) {
      const msg = err?.shortMessage ?? err?.message ?? "Transaction failed";
      res.status(500).json({ ok: false, error: msg.length > 200 ? msg.slice(0, 200) + "…" : msg });
    }
  });

  // ── GET /keeper/positions — position health snapshots for KeeperHub monitors ──
  //
  // Returns every open position with a pre-evaluated `conditions` block so
  // KeeperHub condition nodes can branch without needing to call the scoring
  // API separately.  All numeric thresholds mirror PortfolioManager constants.
  app.get("/keeper/positions", (_req: Request, res: Response) => {
    const positions = portfolio.getPositions().filter(p => p.status === "open");
    const latest    = agent.getLatest();

    const snapshots = positions.map(pos => {
      const pool       = latest.find(l => l.poolId === pos.poolId);
      const score      = pool?.scorecard?.composite ?? 0;
      const hookBlocked= pool?.hookAnalysis?.isBlocked ?? false;
      const tvlUsd     = pool?.tvlUsd ?? 0;
      const inRange    = pos.timeInRangePct >= 80;
      const criticalExit = pos.exitAlerts.some(a =>
        a.includes("RAR") || a.includes("Stale") || a.includes("hook") || a.includes("price move"),
      );

      return {
        positionId:     pos.id,
        poolId:         pos.poolId,
        pair:           pos.pair,
        chainId:        pos.chainId,
        chainName:      pos.chainName,
        hoursHeld:      pos.hoursHeld,
        allocationPct:  pos.allocationPct,
        currentValueUsd: pos.currentValueUsd,
        pnlPct:         pos.pnlPct,
        timeInRangePct: pos.timeInRangePct,
        halfRangePct:   pos.halfRangePct,
        exitAlerts:     pos.exitAlerts,
        inRange,
        compositeScore: score,
        hookIsBlocked:  hookBlocked,
        tvlUsd,
        conditions: {
          inRange,
          scoreOk:         score >= 60,
          hookRiskOk:      !hookBlocked,
          tvlOk:           tvlUsd >= 50_000,
          shouldAlert:     pos.exitAlerts.length > 0,
          shouldRebalance: !inRange && pos.hoursHeld >= 24 && !criticalExit,
          shouldExit:      criticalExit,
        },
      };
    });

    res.json({ count: snapshots.length, data: snapshots });
  });

  // ── POST /keeper/signal — full scoring signal for a pool or position ──────────
  //
  // KeeperHub calls this after its "Read LP position" and "Read current pool tick"
  // steps (workflow step 3).  Returns a `conditions` block with one boolean per
  // decision branch so KeeperHub condition nodes can route without parsing prose.
  //
  // Body: { poolId?, positionId?, chainId? }
  // At least one of poolId or positionId must be supplied.
  app.post("/keeper/signal", (req: Request, res: Response) => {
    const { poolId, positionId } = req.body;
    if (!poolId && !positionId) {
      return res.status(400).json({ error: "Supply at least one of: poolId, positionId" });
    }

    const latest    = agent.getLatest();
    const positions = portfolio.getPositions();

    // Resolve pool (from position's poolId if only positionId given)
    const pos  = positionId ? positions.find(p => p.id === positionId) : undefined;
    const pid  = poolId ?? pos?.poolId;
    const pool = pid ? latest.find(l => l.poolId === pid) : undefined;

    if (!pool && !pos) {
      return res.status(404).json({ error: "Pool/position not found in latest scan" });
    }

    // ── Scoring ────────────────────────────────────────────────────────────────
    const compositeScore  = pool?.scorecard?.composite ?? 0;
    const hookRiskScore   = pool?.scorecard?.hookRisk  ?? 100;
    const hookIsBlocked   = pool?.hookAnalysis?.isBlocked ?? false;
    const effectiveNetAPY = pool?.effectiveNetAPY ?? pool?.netAPY ?? pool?.displayAPY ?? 0;
    const tvlUsd          = pool?.tvlUsd ?? 0;
    const volumeReal      = (pool?.volume24hUsd ?? 0) > 0;

    // ── Position state ─────────────────────────────────────────────────────────
    const inRange     = pos ? pos.timeInRangePct >= 80 : true;
    const criticalExit = pos
      ? pos.exitAlerts.some(a =>
          a.includes("RAR") || a.includes("Stale") || a.includes("hook") || a.includes("price move"),
        )
      : false;

    // ── Conditions (each maps to one KeeperHub condition node branch) ──────────
    const scoreOk         = compositeScore >= 60;
    const hookRiskOk      = !hookIsBlocked;
    const tvlOk           = tvlUsd >= 50_000;
    const volumeOk        = volumeReal;
    const shouldAlert     = pos ? pos.exitAlerts.length > 0 : false;
    const shouldRebalance = pos ? (!inRange && pos.hoursHeld >= 24 && !criticalExit) : false;
    const shouldExit      = criticalExit;
    const canEnterNew     = scoreOk && hookRiskOk && tvlOk && volumeOk && !hookIsBlocked;

    // ── Recommendation ─────────────────────────────────────────────────────────
    let recommendation: string;
    let reasoning: string;

    if (pos) {
      if (shouldExit) {
        recommendation = "exit";
        reasoning = `Critical exit signal: ${pos.exitAlerts.join("; ")}`;
      } else if (shouldRebalance) {
        recommendation = "rebalance";
        reasoning = `Position out of range (TiR ${pos.timeInRangePct.toFixed(1)}%) for ${pos.hoursHeld.toFixed(0)}h`;
      } else if (shouldAlert) {
        recommendation = "alert";
        reasoning = pos.exitAlerts.join("; ");
      } else {
        recommendation = "hold";
        reasoning = `Score ${compositeScore}/100, TiR ${pos.timeInRangePct.toFixed(1)}%, no exit triggers`;
      }
    } else {
      recommendation = canEnterNew ? "enter" : "skip";
      reasoning = canEnterNew
        ? `Score ${compositeScore}/100, effAPY ${effectiveNetAPY.toFixed(1)}%, TVL $${tvlUsd.toLocaleString()}, hook risk OK`
        : [
            !scoreOk    && `score ${compositeScore} < 60`,
            !hookRiskOk && "hook blocked",
            !tvlOk      && `TVL $${tvlUsd.toLocaleString()} < $50k`,
            !volumeOk   && "no 7-day volume",
          ].filter(Boolean).join(", ");
    }

    res.json({
      timestamp:      Date.now(),
      signalType:     pos ? "position" : "pool",
      poolId:         pool?.poolId ?? pos?.poolId,
      pair:           pool?.pair   ?? pos?.pair,
      chainId:        pool?.chainId ?? pos?.chainId,
      chainName:      pool?.chainName ?? pos?.chainName,
      compositeScore,
      hookRiskScore,
      hookIsBlocked,
      effectiveNetAPY,
      tvlUsd,
      volumeReal,
      position: pos ? {
        id:              pos.id,
        hoursHeld:       pos.hoursHeld,
        allocationPct:   pos.allocationPct,
        currentValueUsd: pos.currentValueUsd,
        pnlPct:          pos.pnlPct,
        timeInRangePct:  pos.timeInRangePct,
        halfRangePct:    pos.halfRangePct,
        exitAlerts:      pos.exitAlerts,
        inRange,
      } : undefined,
      conditions: {
        scoreOk,
        hookRiskOk,
        tvlOk,
        volumeOk,
        positionInRange: inRange,
        shouldAlert,
        shouldRebalance,
        shouldExit,
        canEnterNew,
      },
      recommendation,
      reasoning,
    });
  });

  // ── GET /swap/chains — list supported swap chains and their token registries ──
  app.get("/swap/chains", (_req, res) => {
    const chains = Object.entries(SWAP_REGISTRY).map(([id, cfg]) => ({
      chainId:      Number(id),
      name:         cfg.name,
      dexName:      cfg.dexName,
      explorerBase: cfg.explorerBase,
      tokens:       cfg.tokens,
    }));
    res.json({ chains });
  });

  // ── POST /swap/quote — simulate a V3 single-hop swap via QuoterV2 ────────────
  // Body: { chainId, tokenIn, tokenOut, amountIn, decimalsIn, fee? }
  app.post("/swap/quote", async (req: Request, res: Response) => {
    try {
      const { createPublicClient, http, parseUnits, formatUnits } = await import("viem");
      const { chainId, tokenIn, tokenOut, amountIn, decimalsIn, fee: feeTierHint } = req.body;

      if (!chainId || !tokenIn || !tokenOut || amountIn == null) {
        return res.status(400).json({ error: "Missing required fields: chainId, tokenIn, tokenOut, amountIn" });
      }
      const cfg = SWAP_REGISTRY[Number(chainId)];
      if (!cfg) return res.status(400).json({ error: `Unsupported chainId: ${chainId}` });

      const chain      = buildSwapChain(Number(chainId), cfg.rpc);
      const publicClient = createPublicClient({ chain: chain as any, transport: http(cfg.rpc) });
      const amountInBig  = parseUnits(String(amountIn), Number(decimalsIn ?? 18));
      const feeTiers     = feeTierHint ? [Number(feeTierHint)] : [500, 3000, 10000];

      let bestOut = 0n;
      let bestFee = 3000;

      for (const fee of feeTiers) {
        try {
          const { result } = await publicClient.simulateContract({
            address:      cfg.quoter,
            abi:          QUOTER_V2_ABI,
            functionName: "quoteExactInputSingle",
            args: [{ tokenIn: tokenIn as `0x${string}`, tokenOut: tokenOut as `0x${string}`, amountIn: amountInBig, fee, sqrtPriceLimitX96: 0n }],
          });
          const out = (result as readonly [bigint, ...unknown[]])[0];
          if (out > bestOut) { bestOut = out; bestFee = fee; }
        } catch { /* no pool at this tier */ }
      }

      if (bestOut === 0n) {
        return res.status(422).json({ error: "No liquidity found for this pair on any fee tier" });
      }

      const tokenOutMeta = cfg.tokens.find(t => t.address.toLowerCase() === String(tokenOut).toLowerCase());
      const decimalsOut  = tokenOutMeta?.decimals ?? 18;

      res.json({
        amountOut:          bestOut.toString(),
        amountOutFormatted: formatUnits(bestOut, decimalsOut),
        fee:                bestFee,
        tokenOutSymbol:     tokenOutMeta?.symbol ?? "?",
      });
    } catch (err: any) {
      const msg = err?.shortMessage ?? err?.message ?? "Quote failed";
      res.status(500).json({ error: msg.length > 300 ? msg.slice(0, 300) + "…" : msg });
    }
  });

  // ── POST /swap/execute — approve (if needed) + single-hop swap via app wallet ─
  // Body: { chainId, tokenIn, tokenOut, amountIn, decimalsIn, fee, slippageBps? }
  app.post("/swap/execute", async (req: Request, res: Response) => {
    try {
      const { createPublicClient, createWalletClient, http, parseUnits, formatUnits } = await import("viem");
      const { privateKeyToAccount } = await import("viem/accounts");

      const { chainId, tokenIn, tokenOut, amountIn, decimalsIn, fee = 3000, slippageBps = 50 } = req.body;

      if (!chainId || !tokenIn || !tokenOut || amountIn == null) {
        return res.status(400).json({ error: "Missing required fields: chainId, tokenIn, tokenOut, amountIn" });
      }
      const cfg = SWAP_REGISTRY[Number(chainId)];
      if (!cfg) return res.status(400).json({ error: `Unsupported chainId: ${chainId}` });

      const privateKey = process.env.APP_WALLET_PRIVATE_KEY as `0x${string}` | undefined;
      if (!privateKey) {
        return res.status(500).json({ error: "App wallet not configured (APP_WALLET_PRIVATE_KEY missing)" });
      }

      const chain        = buildSwapChain(Number(chainId), cfg.rpc);
      const account      = privateKeyToAccount(privateKey);
      const publicClient = createPublicClient({ chain: chain as any, transport: http(cfg.rpc) });
      const walletClient = createWalletClient({ account, chain: chain as any, transport: http(cfg.rpc) });

      const amountInBig = parseUnits(String(amountIn), Number(decimalsIn ?? 18));

      // 1. Fresh quote for amountOutMinimum
      let amountOut = 0n;
      try {
        const { result } = await publicClient.simulateContract({
          address: cfg.quoter, abi: QUOTER_V2_ABI, functionName: "quoteExactInputSingle",
          args: [{ tokenIn: tokenIn as `0x${string}`, tokenOut: tokenOut as `0x${string}`, amountIn: amountInBig, fee: Number(fee), sqrtPriceLimitX96: 0n }],
        });
        amountOut = (result as readonly [bigint, ...unknown[]])[0];
      } catch {
        return res.status(422).json({ error: "Could not quote this swap — no pool found" });
      }
      const amountOutMin = amountOut * BigInt(10000 - Number(slippageBps)) / 10000n;

      // 2. Approve router if allowance is insufficient
      const currentAllowance = await publicClient.readContract({
        address: tokenIn as `0x${string}`, abi: ERC20_SWAP_ABI, functionName: "allowance",
        args: [account.address, cfg.router],
      }) as bigint;

      let approveTxHash: string | undefined;
      if (currentAllowance < amountInBig) {
        const MAX = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
        const h = await walletClient.writeContract({
          address: tokenIn as `0x${string}`, abi: ERC20_SWAP_ABI, functionName: "approve",
          args: [cfg.router, MAX], chain: chain as any,
        });
        await publicClient.waitForTransactionReceipt({ hash: h, timeout: 120_000 });
        approveTxHash = h;
      }

      // 3. Execute swap
      const swapHash = await walletClient.writeContract({
        address: cfg.router, abi: SWAP_ROUTER_ABI, functionName: "exactInputSingle",
        args: [{
          tokenIn: tokenIn as `0x${string}`, tokenOut: tokenOut as `0x${string}`,
          fee: Number(fee), recipient: account.address,
          amountIn: amountInBig, amountOutMinimum: amountOutMin, sqrtPriceLimitX96: 0n,
        }],
        chain: chain as any,
      });

      const tokenOutMeta = cfg.tokens.find(t => t.address.toLowerCase() === String(tokenOut).toLowerCase());
      const decimalsOut  = tokenOutMeta?.decimals ?? 18;

      res.json({
        ok:                 true,
        txHash:             swapHash,
        approveTxHash,
        amountIn,
        amountOutFormatted: formatUnits(amountOutMin, decimalsOut),
        chainId:            Number(chainId),
        explorerBase:       cfg.explorerBase,
      });
    } catch (err: any) {
      const msg = err?.shortMessage ?? err?.message ?? "Swap failed";
      res.status(500).json({ ok: false, error: msg.length > 300 ? msg.slice(0, 300) + "…" : msg });
    }
  });

  // ── INFT Strategy Agents ─────────────────────────────────────────────────────

  // POST /inft/mint-agent — build metadata, upload to 0G Storage, mint INFT
  app.post("/inft/mint-agent", async (req: Request, res: Response) => {
    try {
      const { inftClient }          = await import("../inft/INFTContractClient");
      const { zeroGStorage }        = await import("../og/ZeroGStorageClient");
      const { buildAgentMetadata }  = await import("../inft/AgentMetadataBuilder");
      const {
        to, strategyType = "eth-usdc-harvest",
        name, version = "1.0",
      } = req.body as {
        to:            string;
        strategyType?: string;
        name?:         string;
        version?:      string;
      };
      if (!to) return res.status(400).json({ error: "to (wallet address) required" });

      const summary     = portfolio.getSummary();
      const metadata    = buildAgentMetadata(strategyType as any, summary);
      const storageUri  = await zeroGStorage.upload(metadata);
      const agentName   = name ?? metadata.name;

      const result = await inftClient.mintAgent({
        to,
        name:         agentName,
        strategyType: metadata.strategyType,
        riskProfile:  metadata.riskProfile,
        storageUri,
        version,
        permissions:  metadata.permissions,
      });

      if ("error" in result) return res.status(500).json({ error: result.error });
      res.json({ tokenId: result.tokenId, txHash: result.txHash, storageUri, metadata });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /inft/agents/:owner — list all INFTs owned by a wallet
  app.get("/inft/agents/:owner", async (req: Request, res: Response) => {
    try {
      const { inftClient }   = await import("../inft/INFTContractClient");
      const { zeroGStorage } = await import("../og/ZeroGStorageClient");
      const { ZEROG_GALILEO_CHAIN_ID } = await import("../inft/INFTContractClient");
      const owner  = req.params.owner;
      const states = await inftClient.getTokensByOwner(owner);
      const records = await Promise.all(states.map(async s => {
        const metadata = s.storageUri ? await zeroGStorage.retrieve(s.storageUri) : null;
        const explorerUrl = `https://chainscan-galileo.0g.ai/token/${process.env.INFT_CONTRACT_ADDRESS}/instance/${s.tokenId}`;
        return { onChain: s, metadata, explorerUrl };
      }));
      res.json({ owner, agents: records });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /inft/:tokenId/metadata — fetch agent state + off-chain metadata bundle
  app.get("/inft/:tokenId/metadata", async (req: Request, res: Response) => {
    try {
      const { inftClient }   = await import("../inft/INFTContractClient");
      const { zeroGStorage } = await import("../og/ZeroGStorageClient");
      const tokenId = Number(req.params.tokenId);
      if (isNaN(tokenId)) return res.status(400).json({ error: "invalid tokenId" });
      const state = await inftClient.getAgentState(tokenId);
      if (!state)  return res.status(404).json({ error: "Token not found" });
      const metadata   = state.storageUri ? await zeroGStorage.retrieve(state.storageUri) : null;
      const explorerUrl = `https://chainscan-galileo.0g.ai/token/${process.env.INFT_CONTRACT_ADDRESS}/instance/${tokenId}`;
      res.json({ onChain: state, metadata, explorerUrl });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /inft/:tokenId/authorize — grant/revoke execution rights for a user
  app.post("/inft/:tokenId/authorize", async (req: Request, res: Response) => {
    try {
      const { inftClient } = await import("../inft/INFTContractClient");
      const tokenId    = Number(req.params.tokenId);
      const { user, authorized = true } = req.body as { user: string; authorized?: boolean };
      if (!user) return res.status(400).json({ error: "user address required" });
      const result = await inftClient.authorizeUsage(tokenId, user, authorized);
      if ("error" in result) return res.status(500).json({ error: result.error });
      res.json({ tokenId, user, authorized, txHash: result.txHash });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /inft/:tokenId/clone — fork strategy to a new owner
  app.post("/inft/:tokenId/clone", async (req: Request, res: Response) => {
    try {
      const { inftClient } = await import("../inft/INFTContractClient");
      const tokenId    = Number(req.params.tokenId);
      const { cloneOwner } = req.body as { cloneOwner: string };
      if (!cloneOwner) return res.status(400).json({ error: "cloneOwner address required" });
      const result = await inftClient.clone(tokenId, cloneOwner);
      if ("error" in result) return res.status(500).json({ error: result.error });
      res.json({ sourceTokenId: tokenId, cloneId: result.cloneId, txHash: result.txHash });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /inft/:tokenId/transfer — transfer INFT to a new owner
  app.post("/inft/:tokenId/transfer", async (req: Request, res: Response) => {
    try {
      const { inftClient } = await import("../inft/INFTContractClient");
      const tokenId    = Number(req.params.tokenId);
      const { from, to } = req.body as { from: string; to: string };
      if (!from || !to) return res.status(400).json({ error: "from and to addresses required" });
      const result = await inftClient.transfer(tokenId, from, to);
      if ("error" in result) return res.status(500).json({ error: result.error });
      res.json({ tokenId, from, to, txHash: result.txHash });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Health ───────────────────────────────────────────────────────────────────
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: Date.now(), poolsScanned: agent.getLatest().length });
  });

  // ── Error handler ────────────────────────────────────────────────────────────
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[API]", err.message);
    const safeMessage = err.message.replace(/[\n\r\t]/g, " ").slice(0, 200);
    res.status(500).json({ error: safeMessage });
  });

  return app;
}

export function startApiServer(agent: ReporterAgent, portfolio: PortfolioManager, reflection: ReflectionAgent, port = 3001): void {
  const app = createApiServer(agent, portfolio, reflection);
  app.listen(port, () => {
    console.log(`[API] Listening on http://localhost:${port}`);
    console.log(`[API] OpenAPI spec at http://localhost:${port}/openapi.json`);
    console.log(`[API] Docs UI at http://localhost:3000/docs`);
  });
}
