import net from "node:net";
import type { BrowserAuditOptions } from "../index.js";
import type { BrowserAuditResult, ParsedProxyInput, ProxyInput } from "../types.js";
import { parseProxyInput } from "../parser.js";
import { validateTargetHost } from "../security/ssrf.js";

// Playwright is an optional peer dependency; dynamic import prevents core auditor from bundling it
type PlaywrightModule = typeof import("playwright");

export async function auditProxyInBrowser(
  proxyInput: ProxyInput,
  options: BrowserAuditOptions = {}
): Promise<BrowserAuditResult> {
  let parsed: ParsedProxyInput;
  try {
    const result = parseProxyInput(proxyInput);
    parsed = result.parsed;
  } catch (err) {
    return {
      supported: false,
      navigationSucceeded: false,
      error: err instanceof Error ? err.message : "Failed to parse proxy input",
    };
  }

  // Playwright only supports HTTP/HTTPS and SOCKS5 proxies
  if (parsed.protocol === "socks4") {
    return {
      supported: false,
      navigationSucceeded: false,
      error: "SOCKS4 proxy protocol is unsupported by browser engines",
    };
  }

  const ssrf = await validateTargetHost(parsed.host, {
    allowPrivateTargets: options.allowPrivateTargets ?? false,
    timeoutMs: options.timeoutMs ?? 3000,
  });

  if (!ssrf.valid || ssrf.resolvedIps.length === 0) {
    return {
      supported: false,
      navigationSucceeded: false,
      error: `Proxy host rejected by SSRF policy: ${ssrf.reason || "restricted"}`,
    };
  }

  const pinnedIp = ssrf.resolvedIps[0]!;
  const echoUrl = options.endpoint || (options.endpoints && options.endpoints[0]) || "https://api.ipify.org";
  const parsedEcho = new URL(echoUrl);

  const echoSsrf = await validateTargetHost(parsedEcho.hostname, {
    allowPrivateTargets: options.allowPrivateTargets ?? false,
    timeoutMs: options.timeoutMs ?? 3000,
  });

  if (!echoSsrf.valid) {
    return {
      supported: false,
      navigationSucceeded: false,
      error: `Browser target endpoint rejected by SSRF policy: ${echoSsrf.reason || "restricted"}`,
    };
  }

  let pw: PlaywrightModule;
  try {
    pw = await import("playwright");
  } catch {
    return {
      supported: false,
      navigationSucceeded: false,
      error: "Playwright optional dependency is not installed in the current environment",
    };
  }

  const timeoutMs = options.timeoutMs ?? 10_000;
  const proxyHostFormatted = net.isIPv6(pinnedIp) ? `[${pinnedIp}]` : pinnedIp;
  const proxyServer = `${parsed.protocol}://${proxyHostFormatted}:${parsed.port}`;
  const proxyConfig: { server: string; username?: string; password?: string } = {
    server: proxyServer,
    ...(parsed.username ? { username: parsed.username } : {}),
    ...(parsed.password ? { password: parsed.password } : {}),
  };

  let browser: import("playwright").Browser | null = null;
  let context: import("playwright").BrowserContext | null = null;
  try {
    browser = await pw.chromium.launch({
      headless: true,
      proxy: proxyConfig,
      timeout: timeoutMs,
    });

    context = await browser.newContext({
      ignoreHTTPSErrors: false,
    });

    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);

    // Strict navigation to configured HTTPS echo endpoint
    const response = await page.goto(echoUrl, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });

    const navigationSucceeded = Boolean(response && response.ok());
    const bodyText = await page.evaluate(() => document.body.innerText || "");
    const matchV4 = bodyText.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
    const matchV6 = bodyText.match(/\b[0-9a-fA-F:]{3,39}\b/);
    const observedBrowserIp = matchV4 ? matchV4[0] : (matchV6 && matchV6[0].includes(":") ? matchV6[0] : undefined);

    // Collect candidate IPs via RTCPeerConnection using specified stun servers
    const stunUrls = options.stunServers && options.stunServers.length > 0
      ? options.stunServers
      : ["stun:stun.l.google.com:19302"];

    const webrtcCandidates = await page.evaluate(async (servers: readonly string[]) => {
      const candidates: string[] = [];
      try {
        const pc = new RTCPeerConnection({
          iceServers: servers.map((url) => ({ urls: url })),
        });
        pc.createDataChannel("");
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        await new Promise<void>((resolve) => {
          pc.onicecandidate = (e) => {
            if (!e.candidate) {
              resolve();
              return;
            }
            const cand = e.candidate.candidate;
            const ipMatch = cand.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
            if (ipMatch && !candidates.includes(ipMatch[0])) candidates.push(ipMatch[0]);
          };
          setTimeout(resolve, 1500);
        });
        pc.close();
      } catch {
        // WebRTC evaluation might fail or be disabled
      }
      return candidates;
    }, stunUrls);

    const publicCandidates = webrtcCandidates.filter((c) => net.isIP(c) && !c.startsWith("127.") && !c.startsWith("10.") && !c.startsWith("192.168."));
    const webrtcLeakDetected = Boolean(
      options.baselinePublicIp &&
      publicCandidates.includes(options.baselinePublicIp)
    );

    return {
      supported: true,
      navigationSucceeded,
      exitIp: observedBrowserIp,
      webrtcLeakDetected: options.baselinePublicIp ? webrtcLeakDetected : false,
      candidates: publicCandidates,
      error: navigationSucceeded ? undefined : `Navigation returned HTTP ${response?.status()}`,
    };
  } catch (err) {
    return {
      supported: true,
      navigationSucceeded: false,
      error: err instanceof Error ? err.message : "Browser navigation failed",
    };
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}
