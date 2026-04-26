import * as dotenv from "dotenv";
import { RiskManagerAgent } from "./RiskManagerAgent";
dotenv.config({ path: "../../.env" });
new RiskManagerAgent(9007).start().catch(console.error);
