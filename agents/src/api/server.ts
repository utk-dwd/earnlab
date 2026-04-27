import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import path from "path";
import yaml from "js-yaml";
import fs from "fs";
import type { ReporterAgent }    from "../ReporterAgent";
import type { PortfolioManager } from "../PortfolioManager";
import type { ReflectionAgent }  from "../llm/ReflectionAgent";
import { SlippageGuard } from "../calculator/SlippageGuard";

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
