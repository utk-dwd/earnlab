import * as dotenv from "dotenv";
import { OrchestratorAgent } from "./OrchestratorAgent";
dotenv.config({ path: "../../.env" });

new OrchestratorAgent(9002).start().catch(console.error);
