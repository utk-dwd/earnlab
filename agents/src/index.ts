import * as dotenv from "dotenv";
dotenv.config({ path: "../.env" });

import { ReporterAgent }    from "./ReporterAgent";
import { PortfolioManager } from "./PortfolioManager";
import { ReflectionAgent }  from "./llm/ReflectionAgent";
import { startApiServer }   from "./api/server";
import { zeroGStorage }     from "./og/ZeroGStorageClient";

const API_PORT = Number(process.env.AGENT_API_PORT ?? 3001);

async function main() {
  await zeroGStorage.init();

  const reporter   = new ReporterAgent();
  const portfolio  = new PortfolioManager(reporter);
  const reflection = new ReflectionAgent(reporter, portfolio);

  startApiServer(reporter, portfolio, reflection, API_PORT);

  // Reporter scans first so portfolio and reflection have opportunity data
  await reporter.start();

  // Portfolio ticks every 5 min; first tick may wait if RAR not yet computed
  await portfolio.start();

  // Reflection runs every hour; starts after first scan so data is available
  await reflection.start();
}

main().catch((err) => {
  console.error("[Main] Fatal:", err);
  process.exit(1);
});
