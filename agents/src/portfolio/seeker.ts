import * as dotenv from "dotenv";
import { SeekerAgent } from "./SeekerAgent";
dotenv.config({ path: "../../.env" });
new SeekerAgent(9006).start().catch(console.error);
