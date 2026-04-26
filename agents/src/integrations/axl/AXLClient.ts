import axios, { AxiosInstance } from "axios";

export interface AXLMessage {
  from: string;   // sender public key (hex)
  body: string;   // raw string payload (we send JSON strings)
}

export interface AXLTopology {
  our_public_key: string;
  our_ipv6:       string;
  peers: Array<{
    public_key: string;
    uri:        string;
    up:         boolean;
    inbound:    boolean;
  }>;
}

/**
 * AXLClient — thin HTTP wrapper around the local AXL node API.
 *
 * Wire format (per AXL source):
 *   POST /send   — header: X-Destination-Peer-Id, body: raw bytes
 *   GET  /recv   — response: raw bytes + X-From-Peer-Id header; 204 = empty
 *   GET  /topology — JSON topology
 */
export class AXLClient {
  private http: AxiosInstance;
  public readonly port: number;
  public publicKey: string = "";

  constructor(port: number = 9002) {
    this.port = port;
    this.http = axios.create({
      baseURL: `http://127.0.0.1:${port}`,
      timeout: 10_000,
    });
  }

  /** Fetch and cache this node's own public key */
  async init(): Promise<string> {
    const topo = await this.topology();
    this.publicKey = topo.our_public_key;
    return this.publicKey;
  }

  /**
   * Send a message to a peer.
   * We serialize `body` to a UTF-8 JSON string and send as raw bytes.
   */
  async send(toPublicKey: string, body: object): Promise<void> {
    const data = Buffer.from(
      JSON.stringify(body, (_, v) => typeof v === "bigint" ? v.toString() : v),
      "utf-8"
    );
    await this.http.post("/send", data, {
      headers: {
        "X-Destination-Peer-Id": toPublicKey,
        "Content-Type": "application/octet-stream",
      },
      responseType: "arraybuffer",
    });
  }

  /**
   * Poll for one message. Returns null when queue is empty (HTTP 204).
   * The sender's public key is in the X-From-Peer-Id response header.
   */
  async receive(): Promise<AXLMessage | null> {
    try {
      const resp = await this.http.get("/recv", {
        responseType: "arraybuffer",
        validateStatus: (s) => s === 200 || s === 204,
      });
      if (resp.status === 204) return null;
      const from = resp.headers["x-from-peer-id"] ?? "";
      const body = Buffer.from(resp.data as ArrayBuffer).toString("utf-8");
      return { from, body };
    } catch (err: any) {
      if (err.response?.status === 204) return null;
      throw err;
    }
  }

  /**
   * Poll continuously, calling handler for each message.
   */
  startPolling(
    handler: (msg: AXLMessage, body: any) => Promise<void>,
    intervalMs = 500
  ): NodeJS.Timer {
    return setInterval(async () => {
      try {
        const msg = await this.receive();
        if (!msg) return;
        let body: any;
        try { body = JSON.parse(msg.body); } catch { body = msg.body; }
        await handler(msg, body);
      } catch (err) {
        console.error(`[AXL:${this.port}] Poll error:`, err);
      }
    }, intervalMs);
  }

  async topology(): Promise<AXLTopology> {
    const resp = await this.http.get("/topology");
    return resp.data;
  }

  async waitForNode(retries = 20, delayMs = 500): Promise<void> {
    for (let i = 0; i < retries; i++) {
      try {
        await this.http.get("/topology");
        return;
      } catch {
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
    throw new Error(`AXL node on port ${this.port} did not start in time`);
  }
}
