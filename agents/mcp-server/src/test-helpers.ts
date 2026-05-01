import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

export function createConnectedTransports(): [Transport, Transport] {
  let serverOnMessage: ((message: JSONRPCMessage) => void) | undefined;
  let clientOnMessage: ((message: JSONRPCMessage) => void) | undefined;

  const serverTransport: Transport = {
    start: async () => {},
    send: async (message: JSONRPCMessage) => {
      // Route server -> client
      setTimeout(() => {
        if (clientOnMessage) clientOnMessage(message);
      }, 0);
    },
    close: async () => {},
    onmessage: (handler) => {
      serverOnMessage = handler;
    },
    onclose: () => {},
    onerror: () => {},
  };

  const clientTransport: Transport = {
    start: async () => {},
    send: async (message: JSONRPCMessage) => {
      // Route client -> server
      setTimeout(() => {
        if (serverOnMessage) serverOnMessage(message);
      }, 0);
    },
    close: async () => {},
    onmessage: (handler) => {
      clientOnMessage = handler;
    },
    onclose: () => {},
    onerror: () => {},
  };

  return [serverTransport, clientTransport];
}
