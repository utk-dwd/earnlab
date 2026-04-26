import * as dotenv from "dotenv";
import { ExecutorAgent } from "./ExecutorAgent";
dotenv.config({ path: "../../.env" });
new ExecutorAgent(9005).start().catch(console.error);
