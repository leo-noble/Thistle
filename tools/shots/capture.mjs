// ============================================================
// Thistle — tools/shots/capture.mjs
//
// Regenerates every screenshot on the website, in site/assets/shots/,
// from the real extension running in real (headless) Google Chrome.
//
//   node tools/shots/capture.mjs
//
// The Chrome install steps are captured from chrome://extensions with
// the Chrome build of Thistle loaded unpacked (dist/ must hold it:
// run tools/package.sh first). The product shots are
// tools/shots/claude.html and popup/popup.html running the shipped
// usage.js, usage.css and popup files.
//
// Extensions.loadUnpacked is only offered over --remote-debugging-pipe
// with --enable-unsafe-extension-debugging, so this speaks the pipe
// protocol (NUL-delimited JSON on fds 3 and 4) rather than a port.
// ============================================================
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const out = path.join(root, "site/assets/shots");
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
fs.mkdirSync(out, { recursive: true });

const version = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")).version;
const zip = path.join(root, "dist", `thistle-chrome-${version}.zip`);
if (!fs.existsSync(zip)) throw new Error(`missing ${zip} — run tools/package.sh first`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "thistle-shots-"));
const extDir = path.join(tmp, "thistle");
fs.mkdirSync(extDir);
execFileSync("unzip", ["-q", zip, "-d", extDir]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function launch(profile) {
  const chrome = spawn(CHROME, [
    "--headless=new", "--remote-debugging-pipe", "--enable-unsafe-extension-debugging",
    `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
    "--force-dark-mode", "--enable-features=WebUIDarkMode", "--hide-scrollbars", "about:blank",
  ], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const [, , , toChrome, fromChrome] = chrome.stdio;
  let id = 0;
  let buf = "";
  const pending = new Map();
  fromChrome.on("data", (d) => {
    buf += d.toString();
    for (let i; (i = buf.indexOf("\0")) >= 0; ) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const m = { id: ++id, method, params };
      if (sessionId) m.sessionId = sessionId;
      pending.set(m.id, (msg) => (msg.error ? reject(new Error(method + ": " + msg.error.message)) : resolve(msg.result)));
      toChrome.write(JSON.stringify(m) + "\0");
    });
  return { chrome, send };
}

async function page(send, width, height) {
  const { targetInfos } = await send("Target.getTargets");
  const { targetId } = targetInfos.find((t) => t.type === "page");
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false }, sessionId);
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] }, sessionId);
  const ev = async (expression) =>
    (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId)).result.value;
  const go = async (url) => {
    await send("Page.navigate", { url }, sessionId);
    await sleep(1200);
  };
  const shot = async (name, clip) => {
    const { data } = await send("Page.captureScreenshot", clip ? { format: "png", clip: { ...clip, scale: 1 } } : { format: "png" }, sessionId);
    fs.writeFileSync(path.join(out, name), Buffer.from(data, "base64"));
    console.log("  " + name);
  };
  return { ev, go, shot };
}

// chrome://extensions lives in nested shadow roots; this reaches into them
// and draws an outline round the control a step is about.
const EXT = `
  const mgr = document.querySelector('extensions-manager').shadowRoot;
  const bar = mgr.querySelector('extensions-toolbar').shadowRoot;
  const mark = (el) => { el.style.outline = '3px solid #ff9f43'; el.style.outlineOffset = '4px'; el.style.borderRadius = '999px'; };
  const unmark = () => bar.querySelectorAll('*').forEach((e) => (e.style.outline = ''));
`;

async function extensionsShots() {
  // Fresh profile, nothing loaded: the "turn on Developer mode" and
  // "Load unpacked" steps.
  {
    const { chrome, send } = launch(path.join(tmp, "profile-a"));
    const p = await page(send, 1280, 640);
    await p.go("chrome://extensions");
    await p.ev(`(() => { ${EXT} mark(bar.querySelector('#devMode')); })()`);
    await p.shot("chrome-2-developer-mode.png", { x: 560, y: 0, width: 720, height: 96 });
    await p.ev(`(async () => { ${EXT} unmark(); bar.querySelector('#devMode').click(); await new Promise(r => setTimeout(r, 700)); mark(bar.querySelector('#loadUnpacked')); })()`);
    await p.shot("chrome-3-load-unpacked.png", { x: 0, y: 0, width: 720, height: 170 });
    chrome.kill();
  }
  // Thistle loaded: the "it's installed" step.
  {
    const { chrome, send } = launch(path.join(tmp, "profile-b"));
    await send("Extensions.loadUnpacked", { path: extDir });
    const p = await page(send, 1280, 640);
    await p.go("chrome://extensions");
    await p.ev(`(async () => { ${EXT} const dm = bar.querySelector('#devMode'); if (!dm.checked) dm.click(); await new Promise(r => setTimeout(r, 700)); })()`);
    await p.shot("chrome-4-installed.png", { x: 0, y: 0, width: 900, height: 470 });
    chrome.kill();
  }
}

async function productShots() {
  const { chrome, send } = launch(path.join(tmp, "profile-c"));
  const stage = pathToFileURL(path.join(root, "tools/shots/claude.html")).href;

  const p = await page(send, 1280, 820);
  // The composer with the panel open over it. Cropped symmetrically about
  // the composer — the greeting is centred on it — and wide enough on both
  // sides for the panel, which overhangs the right; cropping to the union of
  // the two put the composer off-centre in the frame.
  await p.go(stage + "?pct=42&open=1");
  const h = await p.ev(`(() => {
    const d = document.querySelector('.dock').getBoundingClientRect();
    const o = document.querySelector('.th-usage__popover').getBoundingClientRect();
    const g = document.querySelector('.hello').getBoundingClientRect();
    const cx = d.left + d.width / 2;
    const half = Math.max(cx - Math.min(d.left, o.left), Math.max(d.right, o.right) - cx) + 40;
    const top = Math.min(g.top, o.top) - 40, bottom = Math.max(d.bottom, o.bottom) + 40;
    return { x: cx - half, y: top, width: half * 2, height: bottom - top };
  })()`);
  await p.shot("hero.png", h);

  // The ring at each stage, cropped to the footer's right end.
  for (const [pct, name] of [[42, "ring-blue.png"], [80, "ring-yellow.png"], [95, "ring-red.png"]]) {
    await p.go(stage + "?pct=" + pct);
    const r = await p.ev(`(() => { const g = document.querySelector('.th-usage').getBoundingClientRect(); const m = document.querySelector('[data-testid="model-selector-dropdown"]').getBoundingClientRect(); return { x: m.left - 16, y: g.top - 8, width: g.right - m.left + 32, height: g.height + 16 }; })()`);
    await p.shot(name, r);
  }

  // The footer line on its own, for the "made to fit" section.
  await p.go(stage + "?pct=42");
  const f = await p.ev(`(() => { const d = document.querySelector('.dock').getBoundingClientRect(); return { x: d.left - 20, y: d.top - 20, width: d.width + 40, height: d.height + 40 }; })()`);
  await p.shot("composer.png", f);

  // The toolbar popup, filled with a reading.
  const pop = await page(send, 300, 420);
  await pop.go(pathToFileURL(path.join(root, "popup/popup.html")).href);
  const size = await pop.ev(`(() => {
    document.querySelectorAll('[data-disabled]').forEach((e) => e.removeAttribute('data-disabled'));
    setConnected(true, 'Connected');
    hint('24 messages · 6,812 words', false);
    const now = Date.now();
    renderUsage({ session: { pct: 42, resetsAt: new Date(now + 2 * 3600e3 + 14 * 60e3).toISOString(), spent: false },
                  weekly: { pct: 31, resetsAt: new Date(now + 3 * 86400e3).toISOString() } }, true);
    return { width: document.documentElement.scrollWidth, height: document.body.getBoundingClientRect().height };
  })()`);
  await sleep(900);
  await pop.shot("popup.png", { x: 0, y: 0, width: size.width, height: Math.ceil(size.height) });
  chrome.kill();
}

console.log("Capturing into site/assets/shots/");
await extensionsShots();
await productShots();
// Chrome is still flushing its profiles for a moment after kill().
await sleep(800);
fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
process.exit(0);
