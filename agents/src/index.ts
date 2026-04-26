import * as dotenv from "dotenv";
dotenv.config({ path: "../../.env" });

import { YieldHunterAgent } from "./YieldHunterAgent";
import { startApiServer }   from "./api/server";

const API_PORT = Number(process.env.AGENT_API_PORT ?? 3001);

async function main() {
  const agent = new YieldHunterAgent();

  // Start REST API first so the dashboard has an endpoint immediately
  startApiServer(agent, API_PORT);

  // Start the scan loop (non-blocking — runs interval internally)
  await agent.start();
}

main().catch((err) => {
  console.error("[YieldHunter] Fatal:", err);
  process.exit(1);
});
