import * as dotenv from "dotenv";
dotenv.config({ path: "../../.env" });

import { ReporterAgent }    from "./ReporterAgent";
import { PortfolioManager } from "./PortfolioManager";
import { startApiServer }   from "./api/server";

const API_PORT = Number(process.env.AGENT_API_PORT ?? 3001);

async function main() {
  const reporter  = new ReporterAgent();
  const portfolio = new PortfolioManager(reporter);

  startApiServer(reporter, portfolio, API_PORT);

  // Reporter scans first so portfolio has opportunity data to work with
  await reporter.start();

  // Portfolio ticks every 5 min; first tick may wait if RAR not yet computed
  await portfolio.start();
}

main().catch((err) => {
  console.error("[Portfolio] Fatal:", err);
  process.exit(1);
});
