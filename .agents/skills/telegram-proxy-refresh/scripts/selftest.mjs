// Parser smoke check used by `refresh.mjs selftest`.
import assert from "node:assert/strict";

export function selftest({ parseLine, kindOf, validateEntry, parseSince }) {
  const ok = (l, k = "http") => parseLine(l, k);
  assert.deepEqual(ok("1.2.3.4:8080"), { protocol: "http", host: "1.2.3.4", port: 8080 });
  assert.equal(ok("https://1.2.3.4:443", "socks5").protocol, "http");
  assert.equal(ok("socks5://1.2.3.4:1080").protocol, "socks5");
  assert.equal(ok("socks4://1.2.3.4:1080").reject, "socks4");
  for (const l of ["10.0.0.1:80", "127.0.0.1:1", "100.71.252.27:10001", "192.168.1.1:80", "169.254.169.254:80", "999.1.1.1:80"])
    assert.equal(ok(l).reject, "nonPublic", l);
  for (const l of ["1.2.3.4:0", "1.2.3.4:70000"]) assert.equal(ok(l).reject, "port", l);
  for (const l of ["evil.com:80", "1.2.3.4:80;rm -rf /", "\x1b[31m1.2.3.4:80", `1.2.3.4:80${"x".repeat(400)}`])
    assert.equal(ok(l).reject, "format", l);
  assert.equal(ok("   "), null);
  assert.equal(kindOf("socks4 (1).txt"), null);
  assert.equal(kindOf("https (3).txt"), "http");
  assert.throws(() => validateEntry({ protocol: "http", host: "10.0.0.1", port: 80 }));
  const at = (h, m) => new Date(2026, 9, 31, h, m).getTime();
  assert.equal(parseSince("06:11", "2026-10-31").getTime(), at(6, 11));
  assert.equal(parseSince("2026-10-31", "2026-11-05").getTime(), at(0, 0));
  assert.equal(parseSince("2026-10-31 06:11").getTime(), at(6, 11));
  for (const bad of ["garbage", "25:99", "2026-13-40"]) assert.throws(() => parseSince(bad), /--since/, bad);
  console.log("selftest ok");
}
