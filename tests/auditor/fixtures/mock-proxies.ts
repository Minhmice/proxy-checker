import http from "node:http";
import net from "node:net";

export interface MockServerHandle {
  port: number;
  close: () => Promise<void>;
}

export interface MockTargetEcho {
  port: number;
  close: () => Promise<void>;
  recordedRequests: Array<{ method: string; path: string; headers: http.IncomingHttpHeaders; body: string }>;
}

export function startMockTargetEcho(): Promise<MockTargetEcho> {
  const { promise, resolve, reject } = Promise.withResolvers<MockTargetEcho>();
  const recordedRequests: MockTargetEcho["recordedRequests"] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      recordedRequests.push({
        method: req.method || "GET",
        path: req.url || "/",
        headers: req.headers,
        body,
      });
      res.writeHead(200, {
        "Content-Type": "application/json",
        "X-Echo-Path": req.url || "/",
      });
      res.end(JSON.stringify({ ok: true, path: req.url, body }));
    });
  });

  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address() as net.AddressInfo;
    resolve({
      port: address.port,
      recordedRequests,
      close: () => {
        const { promise: pClose, resolve: resClose } = Promise.withResolvers<void>();
        server.close(() => resClose());
        return pClose;
      },
    });
  });

  return promise;
}

export function startScriptedRawHttpServer(
  handler: (socket: net.Socket) => void
): Promise<MockServerHandle> {
  const { promise, resolve, reject } = Promise.withResolvers<MockServerHandle>();
  const activeSockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    activeSockets.add(socket);
    socket.once("close", () => activeSockets.delete(socket));
    handler(socket);
  });

  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address() as net.AddressInfo;
    resolve({
      port: address.port,
      close: () => {
        const { promise: pClose, resolve: resClose } = Promise.withResolvers<void>();
        for (const socket of activeSockets) {
          socket.destroy();
        }
        server.close(() => resClose());
        return pClose;
      },
    });
  });

  return promise;
}

export function startMockHttpProxy(options?: {
  username?: string;
  password?: string;
  delayConnectMs?: number;
  rejectedStatusLine?: string;
}): Promise<MockServerHandle> {
  const { promise, resolve, reject } = Promise.withResolvers<MockServerHandle>();
  const activeSockets = new Set<net.Socket>();

  const server = http.createServer((req, res) => {
    if (options?.username || options?.password) {
      const auth = req.headers["proxy-authorization"];
      const expected = `Basic ${Buffer.from(`${options?.username || ""}:${options?.password || ""}`).toString("base64")}`;
      if (auth !== expected) {
        res.writeHead(407, { "Proxy-Authenticate": 'Basic realm="proxy"' });
        res.end("Proxy Authentication Required");
        return;
      }
    }

    const parsedUrl = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    const forwardReq = http.request(
      {
        host: parsedUrl.hostname,
        port: Number(parsedUrl.port || 80),
        method: req.method,
        path: parsedUrl.pathname + parsedUrl.search,
        headers: { ...req.headers, host: parsedUrl.host },
      },
      (forwardRes) => {
        res.writeHead(forwardRes.statusCode || 502, forwardRes.headers);
        forwardRes.pipe(res);
      }
    );

    forwardReq.on("error", () => {
      res.writeHead(502);
      res.end("Bad Gateway");
    });
    req.pipe(forwardReq);
  });

  server.on("connection", (socket) => {
    activeSockets.add(socket);
    socket.once("close", () => activeSockets.delete(socket));
  });

  server.on("connect", (req, clientSocket, head) => {
    activeSockets.add(clientSocket);
    clientSocket.once("close", () => activeSockets.delete(clientSocket));

    if (options?.rejectedStatusLine) {
      clientSocket.end(`${options.rejectedStatusLine}\r\n\r\n`);
      return;
    }

    if (options?.username || options?.password) {
      const auth = req.headers["proxy-authorization"];
      const expected = `Basic ${Buffer.from(`${options?.username || ""}:${options?.password || ""}`).toString("base64")}`;
      if (auth !== expected) {
        clientSocket.write("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"proxy\"\r\n\r\n");
        clientSocket.end();
        return;
      }
    }

    const [targetHost, rawTargetPort] = (req.url || "").split(":");
    const targetPort = Number(rawTargetPort || 80);

    const proceed = () => {
      const targetSocket = net.connect(targetPort, targetHost, () => {
        activeSockets.add(targetSocket);
        targetSocket.once("close", () => activeSockets.delete(targetSocket));
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head && head.length > 0) {
          targetSocket.write(head);
        }
        clientSocket.pipe(targetSocket);
        targetSocket.pipe(clientSocket);
      });

      targetSocket.on("error", () => {
        clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        clientSocket.end();
      });
    };

    if (options?.delayConnectMs) {
      setTimeout(proceed, options.delayConnectMs);
    } else {
      proceed();
    }
  });

  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address() as net.AddressInfo;
    resolve({
      port: address.port,
      close: () => {
        const { promise: pClose, resolve: resClose } = Promise.withResolvers<void>();
        for (const socket of activeSockets) {
          socket.destroy();
        }
        server.close(() => resClose());
        return pClose;
      },
    });
  });

  return promise;
}

export function startMockSocks4Proxy(): Promise<MockServerHandle> {
  const { promise, resolve, reject } = Promise.withResolvers<MockServerHandle>();
  const activeSockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    activeSockets.add(socket);
    socket.once("close", () => activeSockets.delete(socket));

    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 8) return;

      const vn = buffer[0];
      const cd = buffer[1];
      const dstPort = buffer.readUInt16BE(2);
      const ipBytes = buffer.subarray(4, 8);
      const dstIp = `${ipBytes[0]}.${ipBytes[1]}.${ipBytes[2]}.${ipBytes[3]}`;

      if (vn !== 0x04 || cd !== 0x01) {
        socket.write(Buffer.from([0x00, 0x5b, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
        socket.end();
        return;
      }

      const nullIdx = buffer.indexOf(0x00, 8);
      if (nullIdx === -1) return;

      socket.removeListener("data", onData);
      const remainder = buffer.subarray(nullIdx + 1);

      const targetSocket = net.connect(dstPort, dstIp, () => {
        activeSockets.add(targetSocket);
        targetSocket.once("close", () => activeSockets.delete(targetSocket));
        socket.write(Buffer.from([0x00, 0x5a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
        if (remainder.length > 0) {
          targetSocket.write(remainder);
        }
        socket.pipe(targetSocket);
        targetSocket.pipe(socket);
      });

      targetSocket.on("error", () => {
        socket.write(Buffer.from([0x00, 0x5b, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
        socket.end();
      });
    };

    socket.on("data", onData);
  });

  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address() as net.AddressInfo;
    resolve({
      port: address.port,
      close: () => {
        const { promise: pClose, resolve: resClose } = Promise.withResolvers<void>();
        for (const socket of activeSockets) {
          socket.destroy();
        }
        server.close(() => resClose());
        return pClose;
      },
    });
  });

  return promise;
}

export function startMockSocks5Proxy(options?: {
  username?: string;
  password?: string;
  delayHandshakeMs?: number;
  delayMethodMs?: number;
  delayAuthMs?: number;
}): Promise<MockServerHandle & { lastTarget?: { type: "ipv4" | "domain"; host: string; port: number } }> {
  const { promise, resolve, reject } = Promise.withResolvers<
    MockServerHandle & { lastTarget?: { type: "ipv4" | "domain"; host: string; port: number } }
  >();
  const activeSockets = new Set<net.Socket>();
  const state: { lastTarget?: { type: "ipv4" | "domain"; host: string; port: number } } = {};

  const server = net.createServer((socket) => {
    activeSockets.add(socket);
    socket.once("close", () => activeSockets.delete(socket));

    let stage: "methods" | "auth" | "request" | "pipe" = "methods";
    let buffer = Buffer.alloc(0);

    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (stage === "methods") {
        if (buffer.length < 2) return;
        const ver = buffer[0];
        const nmethods = buffer[1];
        if (ver !== 0x05 || buffer.length < 2 + nmethods) return;

        const methods = buffer.subarray(2, 2 + nmethods);
        buffer = buffer.subarray(2 + nmethods);

        const requiresAuth = Boolean(options?.username || options?.password);
        const expectedMethod = requiresAuth ? 0x02 : 0x00;

        if (!methods.includes(expectedMethod)) {
          socket.write(Buffer.from([0x05, 0xff]));
          socket.end();
          return;
        }

        const sendMethod = () => socket.write(Buffer.from([0x05, expectedMethod]));
        if (options?.delayMethodMs) {
          setTimeout(sendMethod, options.delayMethodMs);
        } else {
          sendMethod();
        }
        stage = requiresAuth ? "auth" : "request";
      }

      if (stage === "auth") {
        if (buffer.length < 2) return;
        const authVer = buffer[0];
        const ulen = buffer[1];
        if (authVer !== 0x01 || buffer.length < 2 + ulen + 1) return;

        const uname = buffer.subarray(2, 2 + ulen).toString("utf8");
        const plen = buffer[2 + ulen];
        if (buffer.length < 2 + ulen + 1 + plen) return;

        const pass = buffer.subarray(2 + ulen + 1, 2 + ulen + 1 + plen).toString("utf8");
        buffer = buffer.subarray(2 + ulen + 1 + plen);

        if (uname !== (options?.username || "") || pass !== (options?.password || "")) {
          socket.write(Buffer.from([0x01, 0x01]));
          socket.end();
          return;
        }

        const sendAuth = () => socket.write(Buffer.from([0x01, 0x00]));
        if (options?.delayAuthMs) {
          setTimeout(sendAuth, options.delayAuthMs);
        } else {
          sendAuth();
        }
        stage = "request";
      }

      if (stage === "request") {
        if (buffer.length < 4) return;
        const ver = buffer[0];
        const cmd = buffer[1];
        const rsv = buffer[2];
        const atyp = buffer[3];

        if (ver !== 0x05 || cmd !== 0x01 || rsv !== 0x00) {
          socket.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          socket.end();
          return;
        }

        let host = "";
        let targetPort = 0;
        let bytesNeeded = 0;
        let targetType: "ipv4" | "domain" = "ipv4";

        if (atyp === 0x01) {
          bytesNeeded = 10;
          if (buffer.length < bytesNeeded) return;
          host = `${buffer[4]}.${buffer[5]}.${buffer[6]}.${buffer[7]}`;
          targetPort = buffer.readUInt16BE(8);
          targetType = "ipv4";
        } else if (atyp === 0x03) {
          const dlen = buffer[4];
          bytesNeeded = 5 + dlen + 2;
          if (buffer.length < bytesNeeded) return;
          host = buffer.subarray(5, 5 + dlen).toString("utf8");
          targetPort = buffer.readUInt16BE(5 + dlen);
          targetType = "domain";
        } else {
          socket.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          socket.end();
          return;
        }

        const remainder = buffer.subarray(bytesNeeded);
        buffer = Buffer.alloc(0);
        stage = "pipe";
        socket.removeListener("data", onData);

        state.lastTarget = { type: targetType, host, port: targetPort };

        const proceed = () => {
          const targetSocket = net.connect(targetPort, host, () => {
            activeSockets.add(targetSocket);
            targetSocket.once("close", () => activeSockets.delete(targetSocket));
            socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
            if (remainder.length > 0) {
              targetSocket.write(remainder);
            }
            socket.pipe(targetSocket);
            targetSocket.pipe(socket);
          });

          targetSocket.on("error", () => {
            socket.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            socket.end();
          });
        };

        if (options?.delayHandshakeMs) {
          setTimeout(proceed, options.delayHandshakeMs);
        } else {
          proceed();
        }
      }
    };

    socket.on("data", onData);
  });

  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address() as net.AddressInfo;
    resolve({
      port: address.port,
      get lastTarget() {
        return state.lastTarget;
      },
      close: () => {
        const { promise: pClose, resolve: resClose } = Promise.withResolvers<void>();
        for (const socket of activeSockets) {
          socket.destroy();
        }
        server.close(() => resClose());
        return pClose;
      },
    });
  });

  return promise;
}
