import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { inflightTracker } from "../../../../src/lib/lifecycle/inflight";
import { Lifecycle } from "../../../../src/lib/lifecycle/lifecycle";

describe("inflightTracker during shutdown", () => {
  it("should close a keep-alive socket whose last request ends after shutdown started", async () => {
    const lifecycle = new Lifecycle();
    const app = express();
    app.use(inflightTracker(lifecycle));
    app.get("/slow", (_req, res) => {
      setTimeout(() => {
        res.json({ ok: true });
      }, 150);
    });
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const agent = new http.Agent({ keepAlive: true });

    const responded = new Promise<void>((resolve, reject) => {
      http
        .get({ port, host: "127.0.0.1", path: "/slow", agent }, (res) => {
          res.resume();
          res.on("end", resolve);
        })
        .on("error", reject);
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    lifecycle.markShuttingDown();
    const closed = new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
      server.closeIdleConnections();
    });

    await responded;
    const outcome = await Promise.race([
      closed.then(() => "closed"),
      new Promise((resolve) => setTimeout(() => resolve("stalled"), 3000)),
    ]);
    agent.destroy();

    expect(outcome).toBe("closed");
  });
});
