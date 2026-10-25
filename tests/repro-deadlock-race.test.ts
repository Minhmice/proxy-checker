import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createAntigravityRotator } from "../src/server/antigravity-rotator.js";
import {
  listAntigravityConnections,
  clearNineRouterSession,
} from "../src/server/nine-router-client.js";

const originalFetch = globalThis.fetch;

test("FIX VERIFIED BUG 1: Timeout giải phóng runRotation khi 1 router URL bị freeze socket", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-rotator-deadlock-"));
  clearNineRouterSession();

  const urlNormal = "http://router-normal.local:8080";
  const urlFreeze = "http://router-freeze.local:8080";

  let freezeCallCount = 0;
  let normalCallCount = 0;

  const { promise: freezePromise } = Promise.withResolvers<Response>();

  globalThis.fetch = (async (input: string | URL | Request) => {
    const urlStr = String(input);
    if (urlStr.startsWith(urlNormal)) {
      normalCallCount++;
      if (urlStr.includes("/api/auth/login")) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "set-cookie": "auth_token=normal-token; Path=/",
          },
        });
      }
      return new Response(
        JSON.stringify({
          connections: [
            {
              id: "acc-1",
              name: "Account 1",
              provider: "antigravity",
              isActive: true,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (urlStr.startsWith(urlFreeze)) {
      freezeCallCount++;
      return freezePromise;
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const rotator = createAntigravityRotator({
    dataDir: tmpDir,
    endpointTimeoutMs: 50,
    history: {
      get: () => undefined,
      recordActivation: () => ({ accountId: "", turnCount: 0, lastActivatedAt: 0 }),
      close: () => {},
    },
    getRouterUrls: () => [urlNormal, urlFreeze],
    getUsage: async () => ({
      quotas: {
        gemini_session: { remainingPercentage: 90 },
      },
    }),
  });

  try {
    // 1. Kích hoạt runRotation() - router freeze sẽ bị timeout sau 50ms
    const snapshot = await rotator.runRotation();

    // Xác nhận: rotation hoàn thành, không bị treo
    assert.equal(rotator.isRunning, false, "rotator.isRunning phải trở về false");
    assert.equal(normalCallCount >= 1, true, "URL normal phải được xử lý");
    assert.equal(freezeCallCount >= 1, true, "URL freeze phải được gọi");

    // URL normal thành công, URL freeze ghi nhận lỗi timeout trong endpoint summary
    const epNormal = snapshot.endpoints?.find((e) => e.url === urlNormal);
    const epFreeze = snapshot.endpoints?.find((e) => e.url === urlFreeze);
    assert.equal(epNormal?.ok, true);
    assert.equal(epFreeze?.ok, false);

    // 2. Chạy tiếp runRotation() lần 2 không bị nghẽn
    const snapshot2 = await rotator.runRotation();
    assert.equal(rotator.isRunning, false, "Lần chạy thứ 2 cũng hoàn tất mà không bị kẹt");
    assert.equal(snapshot2.accounts.length >= 1, true);
  } finally {
    globalThis.fetch = originalFetch;
    clearNineRouterSession();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("FIX VERIFIED BUG 2: Single-Flight Login - 2 request đồng thời nhận 401 chỉ kích hoạt 1 login", async () => {
  clearNineRouterSession();

  const testUrl = "http://router-race.local:8080";
  const overrides = {
    url: testUrl,
    password: "mock-password-123",
  };

  let loginCallCount = 0;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const urlStr = String(input);

    if (urlStr.includes("/api/auth/login")) {
      loginCallCount++;
      // Nhường event loop một tick để request thứ 2 kịp dính 401 và chạm vào in-flight login
      const { promise: tickPromise, resolve: resolveTick } = Promise.withResolvers<void>();
      setImmediate(resolveTick);
      await tickPromise;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "set-cookie": `auth_token=token-${loginCallCount}; Path=/`,
        },
      });
    }

    if (urlStr.includes("/api/providers/client")) {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const cookie = headers["Cookie"] || headers["cookie"] || "";

      // Giả lập chưa có token hoặc token hết hạn -> trả 401
      if (!cookie.includes("auth_token=token-")) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }

      // Sau khi login xong có token mới -> trả thành công
      return new Response(
        JSON.stringify({
          connections: [{ id: "acc-1", provider: "antigravity", isActive: true }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    // Bắn 2 request đồng thời
    const [res1, res2] = await Promise.all([
      listAntigravityConnections(overrides),
      listAntigravityConnections(overrides),
    ]);

    assert.equal(res1.length, 1);
    assert.equal(res2.length, 1);

    // XÁC NHẬN FIX:
    // Nhờ single-flight pattern với inFlightLoginsByUrl, chỉ có đúng 1 request login được gửi đi!
    assert.equal(
      loginCallCount,
      1,
      `Kỳ vọng single-flight login chỉ gọi đúng 1 lần POST /api/auth/login (thực tế: ${loginCallCount})`,
    );
  } finally {
    globalThis.fetch = originalFetch;
    clearNineRouterSession();
  }
});
