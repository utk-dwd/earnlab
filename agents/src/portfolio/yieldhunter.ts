import * as dotenv from "dotenv";
import { YieldHunterAgent } from "./YieldHunterAgent";
dotenv.config({ path: "../../.env" });
new YieldHunterAgent(9006).start().catch(console.error);
