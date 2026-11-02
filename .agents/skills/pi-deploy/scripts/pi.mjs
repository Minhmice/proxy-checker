#!/usr/bin/env node
// Pi helper. Run from repo root:
//   node .agents/skills/pi-deploy/scripts/pi.mjs status | logs [n] | exec <cmd> | sudo <cmd> | sync [--no-build]
// Reads PI_SSH_HOST / PI_SSH_USER / PI_SSH_PASS / DEPLOY_DIR from .env.
// ponytail: password SSH + full-tree tar upload; move to key auth / rsync once the Pi has a key.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Client } from "ssh2";

const env = {};
for (const l of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
  const m = l.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^"|"$/g, "");
}
for (const k of ["PI_SSH_HOST", "PI_SSH_USER", "PI_SSH_PASS"]) {
  if (!env[k]) throw new Error(`${k} missing in .env`);
}
const DIR = env.DEPLOY_DIR || "/opt/proxyfleet";
const SVC = "proxy-control-dashboard";
const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

const conn = await new Promise((res, rej) => {
  const c = new Client();
  c.on("ready", () => res(c)).on("error", rej);
  c.connect({
    host: env.PI_SSH_HOST,
    port: 22,
    username: env.PI_SSH_USER,
    password: env.PI_SSH_PASS,
    readyTimeout: 10000,
    keepaliveInterval: 10000,
  });
});

const run = (cmd, { stdin, quiet } = {}) =>
  new Promise((res, rej) =>
    conn.exec(cmd, (e, s) => {
      if (e) return rej(e);
      let out = "";
      const on = (d) => {
        out += d;
        if (!quiet) process.stdout.write(d);
      };
      s.on("data", on).stderr.on("data", on);
      s.on("close", (code) => res({ code, out }));
      if (stdin !== undefined) s.end(stdin);
    }),
  );
const sudo = (cmd, o) => run(`sudo -S -p "" bash -c ${q(cmd)}`, { ...o, stdin: `${env.PI_SSH_PASS}\n` });
const put = (local, remote) =>
  new Promise((res, rej) =>
    conn.sftp((e, sf) => (e ? rej(e) : sf.fastPut(local, remote, (x) => (x ? rej(x) : res())))),
  );

async function healthy() {
  for (let i = 0; i < 15; i++) {
    const r = await run('curl -s -m 5 -o /dev/null -w "%{http_code}" http://127.0.0.1:1300/api/health', { quiet: true });
    if (r.out.trim() === "200") return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

async function sync(noBuild) {
  const tgz = ".pi-upload.tgz";
  const skip = ["node_modules", "data", ".git", ".next-build", ".next", ".worktrees", "backups", ".impeccable", ".serena", ".superpowers", "agent/output", "tsconfig.tsbuildinfo", ".env", tgz];
  const t = spawnSync("tar", ["-czf", tgz, ...skip.map((e) => `--exclude=./${e}`), "."], { stdio: "inherit" });
  if (t.status !== 0) throw new Error("tar failed");
  try {
    await sudo(`mkdir -p ${DIR}/backups /var/lib/proxyfleet && chown -R ${env.PI_SSH_USER}:${env.PI_SSH_USER} ${DIR}`);
    const remoteLock = (await run(`sha256sum ${DIR}/package-lock.json 2>/dev/null | cut -d' ' -f1`, { quiet: true })).out.trim();
    await put(tgz, "/tmp/pi-upload.tgz");
    const x = await run(`cd ${DIR} && rm -rf src public scripts tests deploy .agents && tar xzf /tmp/pi-upload.tgz && rm /tmp/pi-upload.tgz`);
    if (x.code !== 0) throw new Error("extract failed");
    // .env on the Pi is never overwritten; seeded only when absent.
    if ((await run(`test -f ${DIR}/.env`, { quiet: true })).code !== 0) {
      await put(".env", `${DIR}/.env`);
      await sudo(`chmod 600 ${DIR}/.env`);
      console.log("[pi] seeded .env");
    }
    const localLock = createHash("sha256").update(fs.readFileSync("package-lock.json")).digest("hex");
    const noModules = (await run(`test -d ${DIR}/node_modules`, { quiet: true })).code !== 0;
    if (noModules || remoteLock !== localLock) {
      if ((await run(`cd ${DIR} && npm ci --no-audit --no-fund`)).code !== 0) throw new Error("npm ci failed");
    }
    if (!noBuild) {
      const b = await run(`cd ${DIR} && NODE_OPTIONS=--max-old-space-size=1024 npm run build`);
      if (b.code !== 0) throw new Error("build failed; service not restarted");
    }
    await sudo(`if [ -f ${DIR}/deploy/systemd/${SVC}.service ]; then cp ${DIR}/deploy/systemd/${SVC}.service /etc/systemd/system/ && systemctl daemon-reload && systemctl enable ${SVC}; fi && systemctl daemon-reload && systemctl restart ${SVC}`);
    if (!(await healthy())) {
      await sudo(`journalctl -u ${SVC} -n 30 --no-pager | cut -c1-220`);
      throw new Error("health check failed after restart");
    }
    console.log("[pi] sync OK, /api/health 200");
  } finally {
    fs.rmSync(tgz, { force: true });
  }
}

const [cmd, ...rest] = process.argv.slice(2);
let code = 0;
try {
  if (cmd === "status") {
    code = (await run(`systemctl is-active ${SVC}; systemctl status ${SVC} --no-pager | head -6; free -h | head -2; curl -s -m 5 -w " health:%{http_code}\\n" http://127.0.0.1:1300/api/health`)).code;
  } else if (cmd === "logs") {
    code = (await sudo(`journalctl -u ${SVC} -n ${Number(rest[0]) || 40} --no-pager | cut -c1-220`)).code;
  } else if (cmd === "exec") {
    code = (await run(`cd ${DIR} && ${rest.join(" ")}`)).code;
  } else if (cmd === "sudo") {
    code = (await sudo(`cd ${DIR} && ${rest.join(" ")}`)).code;
  } else if (cmd === "sync") {
    await sync(rest.includes("--no-build"));
  } else {
    console.error("usage: pi.mjs status | logs [n] | exec <cmd> | sudo <cmd> | sync [--no-build]");
    code = 2;
  }
} catch (e) {
  console.error(`[pi] ${e.message}`);
  code = 1;
} finally {
  conn.end();
}
process.exit(code);
