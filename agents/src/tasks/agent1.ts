import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { UniswapScannerAgent } from "./UniswapScannerAgent";

dotenv.config({ path: "../../.env" });

// Read orchestrator public key from keys file (written by start-all.sh)
const keysPath = path.resolve(__dirname, "../../axl/keys/public-keys.json");
const keys = JSON.parse(fs.readFileSync(keysPath, "utf-8"));
new UniswapScannerAgent(keys.orchestrator).start().catch(console.error);
