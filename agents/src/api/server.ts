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

  // ── Health ───────────────────────────────────────────────────────────────────
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: Date.now(), poolsScanned: agent.getLatest().length });
  });

  // ── Error handler ────────────────────────────────────────────────────────────
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[API]", err.message);
    res.status(500).json({ error: err.message });
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
