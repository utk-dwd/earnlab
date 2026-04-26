import * as dotenv from "dotenv";
import { PortfolioManagerAgent } from "./PortfolioManagerAgent";
dotenv.config({ path: "../../.env" });
new PortfolioManagerAgent(9005).start().catch(console.error);
