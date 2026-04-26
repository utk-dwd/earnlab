import * as dotenv from "dotenv";
import { CriticAgent } from "./CriticAgent";
dotenv.config({ path: "../../.env" });
new CriticAgent(9007).start().catch(console.error);
