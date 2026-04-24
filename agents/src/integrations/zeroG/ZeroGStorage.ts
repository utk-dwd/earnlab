import axios from "axios";
const ZG_STORAGE_NODE = process.env.ZG_STORAGE_NODE ?? "http://127.0.0.1:5678";
export class ZeroGStorage {
  private endpoint: string;
  constructor(endpoint?: string) { this.endpoint = endpoint ?? ZG_STORAGE_NODE; }
  async store(data: string): Promise<string> {
    const resp = await axios.post(`${this.endpoint}/upload`, { data: Buffer.from(data).toString("base64"), contentType: "application/json" });
    return resp.data.cid as string;
  }
  async retrieve(cid: string): Promise<string> {
    const resp = await axios.get(`${this.endpoint}/download/${cid}`);
    return Buffer.from(resp.data.data, "base64").toString("utf-8");
  }
}
