const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const { sleep, cleanupDir, cleanupFile } = require("./utils");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const MAX_VIDEO_BYTES = 80 * 1024 * 1024;

// 実行中ジョブの中断管理
const activeJobs = new Map();

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
  })
);
app.use(express.json({ limit: "2mb" }));

function normalizeCookies(rawCookie, targetUrl = "https://padlet.com") {
  if (!rawCookie) return [];

  let defaultDomain = ".padlet.com";
  try {
    const u = new URL(targetUrl);
    if (u.hostname) {
      defaultDomain = u.hostname.startsWith("www.")
        ? u.hostname.slice(3)
        : "." + u.hostname.replace(/^\./, "");
    }
  } catch (_) {}

  try {
    const parsed = typeof rawCookie === "string" ? JSON.parse(rawCookie) : rawCookie;
    const arr = Array.isArray(parsed)
      ? Array.isArray(parsed[0])
        ? parsed[0]
        : parsed
      : null;

    if (Array.isArray(arr)) {
      return arr
        .filter((c) => c && c.name && c.value !== undefined)
        .map((c) => {
          const cookieObj = {
            name: String(c.name),
            value: String(c.value),
            domain: c.domain || defaultDomain,
            path: c.path || "/",
            httpOnly: Boolean(c.httpOnly),
            secure: c.secure !== undefined ? Boolean(c.secure) : true
          };
          if (c.sameSite && /^(Strict|Lax|None)$/i.test(String(c.sameSite))) {
            const s = String(c.sameSite).toLowerCase();
            cookieObj.sameSite = s === "strict" ? "Strict" : s === "none" ? "None" : "Lax";
          }
          if (typeof c.expirationDate === "number" && Number.isFinite(c.expirationDate)) {
            cookieObj.expires = Math.floor(c.expirationDate);
          } else if (typeof c.expires === "number" && Number.isFinite(c.expires)) {
            cookieObj.expires = Math.floor(c.expires);
          }
          return cookieObj;
        });
    }
  } catch (_) {}

  if (typeof rawCookie === "string" && rawCookie.includes("=")) {
    return rawCookie
      .split(";")
      .map((pair) => pair.trim())
      .filter(Boolean)
      .map((pair) => {
        const eqIdx = pair.indexOf("=");
        if (eqIdx <= 0) return null;
        return {
          name: pair.slice(0, eqIdx).trim(),
          value: pair.slice(eqIdx + 1).trim(),
          domain: defaultDomain,
          path: "/",
          secure: true
        };
      })
      .filter(Boolean);
  }

  return [];
}

function resolveLocalGifPath(customGifName = "") {
  const candidates = [];
  if (customGifName && String(customGifName).trim()) {
    const cleaned = String(customGifName).trim().replace(/^[/\\]+/, "");
    candidates.push(path.join(__dirname, cleaned));
    candidates.push(path.join(__dirname, path.basename(cleaned)));
  }
  candidates.push(
    path.join(__dirname, "_______.gif"),
    path.join(__dirname, "_______ (3).gif"),
    path.join(__dirname, "image.gif")
  );

  for (const p of candidates) {
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      return p;
    }
  }
  return null;
}

async function setEditableValueExact(locator, text) {
  await locator.click();
  await locator.fill(text);
}

async function sleepWithStop(ms, shouldStop) {
  const step = 150;
  let elapsed = 0;
  while (elapsed < ms) {
    if (shouldStop()) return true;
    const chunk = Math.min(step, ms - elapsed);
    await sleep(chunk);
    elapsed += chunk;
  }
  return shouldStop();
}

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});

app.get("/", (req, res) => {
  res.json({ status: "ok", mode: "playwright-exact-runner" });
});

app.post("/stop", (req, res) => {
  const { jobId } = req.body || {};
  if (jobId && activeJobs.has(jobId)) {
    activeJobs.get(jobId).stopped = true;
    return res.json({ ok: true, stopped: true, jobId });
  }
  // jobId 未指定の場合は実行中ジョブをすべて停止
  let stoppedCount = 0;
  for (const [id, job] of activeJobs.entries()) {
    job.stopped = true;
    stoppedCount++;
  }
  return res.json({ ok: true, stopped: stoppedCount > 0, stoppedCount });
});

app.post("/run", async (req, res) => {
  const {
    jobId: reqJobId = "",
    roomUrl = "",
    titleMessage = "お知らせ",
    message = "メッセージ",
    commentMessage = "",
    gifFile = "",
    cookie = "",
    repeat = 2,
    commentRepeat = 1,
    enablePost = true,
    enableComment = false,
    enableVideo = true
  } = req.body || {};

  const trimmedUrl = String(roomUrl || "").trim();
  if (!trimmedUrl) {
    return res.status(400).json({ ok: false, error: "roomUrl が指定されていません。" });
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(trimmedUrl);
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      throw new Error("Invalid protocol");
    }
  } catch (_) {
    return res.status(400).json({ ok: false, error: "有効な http/https の roomUrl を指定してください。" });
  }

  const doPost = Boolean(enablePost);
  const doComment = Boolean(enableComment);
  const doVideo = Boolean(enableVideo);

  if (!doPost && !doComment) {
    return res.status(400).json({
      ok: false,
      error: "投稿（enablePost）とコメント（enableComment）が両方オフになっています。"
    });
  }

  const jobId = String(reqJobId || "").trim() || crypto.randomUUID();
  const jobState = { stopped: false };
  activeJobs.set(jobId, jobState);
  const shouldStop = () => Boolean(jobState.stopped);

  const totalRounds = Math.max(1, Math.min(10, Number(repeat) || 2));
  const cRepeat = Math.max(1, Math.min(10, Number(commentRepeat) || 1));
  const finalTitle = String(titleMessage || "").trim() || "お知らせ";
  const finalPostMsg = String(message || "").trim() || "メッセージ";
  const finalCommentMsg = String(commentMessage || "").trim() || finalPostMsg;
  const imagePath = resolveLocalGifPath(gifFile);

  const logs = [];
  let browser = null;
  let context = null;
  let page = null;
  let authFile = null;
  let detectedSections = 0;
  let stoppedByUser = false;

  const videoDir = doVideo ? fs.mkdtempSync(path.join(os.tmpdir(), "padlet_rec_")) : null;

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu"
      ]
    });

    const cookies = normalizeCookies(cookie, parsedUrl.toString());
    const contextOptions = {
      viewport: { width: 1280, height: 720 }
    };

    if (doVideo && videoDir) {
      contextOptions.recordVideo = {
        dir: videoDir,
        size: { width: 1280, height: 720 }
      };
    }

    if (cookies.length > 0) {
      const cleanedCookies = cookies.map((c) => ({
        ...c,
        sameSite: ["Strict", "Lax", "None"].includes(c.sameSite) ? c.sameSite : "Lax"
      }));
      authFile = path.join(os.tmpdir(), `samon_auth_${jobId}.json`);
      fs.writeFileSync(
        authFile,
        JSON.stringify({ cookies: cleanedCookies, origins: [] }, null, 2)
      );
      contextOptions.storageState = authFile;
    }

    context = await browser.newContext(contextOptions);
    page = await context.newPage();

    if (shouldStop()) {
      stoppedByUser = true;
    } else {
      await page.goto(parsedUrl.toString(), { waitUntil: "domcontentloaded", timeout: 60000 });
      stoppedByUser = await sleepWithStop(6000, shouldStop);
    }

    if (!stoppedByUser) {
      for (let roundNum = 1; roundNum <= totalRounds; roundNum++) {
        if (shouldStop()) {
          stoppedByUser = true;
          break;
        }

        if (doPost) {
          const totalSections = await page.evaluate(() => {
            const addBtns = Array.from(
              document.querySelectorAll('button, [role="button"], [data-testid*="add"]')
            );
            let count = 0;
            for (const btn of addBtns) {
              const rect = btn.getBoundingClientRect();
              const text = (btn.innerText || "").trim();
              const aria = btn.getAttribute("aria-label") || "";
              const cls = typeof btn.className === "string" ? btn.className : "";
              if (
                (text === "+" ||
                  aria.includes("Add") ||
                  aria.includes("追加") ||
                  cls.includes("add")) &&
                rect.y > 0 &&
                rect.y < 350 &&
                rect.width > 0
              ) {
                count++;
              }
            }
            return count;
          });

          const loopCount = Math.max(totalSections, 1);
          detectedSections = loopCount;

          for (let secIdx = 0; secIdx < loopCount; secIdx++) {
            if (shouldStop()) {
              stoppedByUser = true;
              break;
            }

            const sectionName = `Section ${secIdx + 1}`;
            try {
              const clickedAdd = await page.evaluate((targetIdx) => {
                const addBtns = Array.from(
                  document.querySelectorAll('button, [role="button"], [data-testid*="add"]')
                );
                let count = 0;
                for (const btn of addBtns) {
                  const rect = btn.getBoundingClientRect();
                  const text = (btn.innerText || "").trim();
                  const aria = btn.getAttribute("aria-label") || "";
                  const cls = typeof btn.className === "string" ? btn.className : "";
                  if (
                    (text === "+" ||
                      aria.includes("Add") ||
                      aria.includes("追加") ||
                      cls.includes("add")) &&
                    rect.y > 0 &&
                    rect.y < 350 &&
                    rect.width > 0
                  ) {
                    if (count === targetIdx) {
                      btn.click();
                      return true;
                    }
                    count++;
                  }
                }
                return false;
              }, secIdx);

              if (!clickedAdd) {
                logs.push({
                  type: "post",
                  section: sectionName,
                  attempt: roundNum,
                  status: "error",
                  detail: `セクション ${secIdx + 1} の追加ボタンが見つかりませんでした`,
                  timestamp: new Date().toISOString()
                });
                continue;
              }

              if (await sleepWithStop(1500, shouldStop)) {
                stoppedByUser = true;
                break;
              }

              const editables = page.locator(
                'div[contenteditable="true"], textarea, input[type="text"]'
              );
              const editableCount = await editables.count();
              if (editableCount > 0) {
                await setEditableValueExact(editables.nth(0), finalTitle);
              }
              if (editableCount > 1) {
                await setEditableValueExact(editables.nth(1), finalPostMsg);
              }

              if (await sleepWithStop(800, shouldStop)) {
                stoppedByUser = true;
                break;
              }

              if (imagePath && fs.existsSync(imagePath)) {
                try {
                  const fileInput = page.locator('input[type="file"]').first();
                  if ((await fileInput.count()) > 0) {
                    await fileInput.setInputFiles(imagePath);
                    if (await sleepWithStop(2000, shouldStop)) {
                      stoppedByUser = true;
                      break;
                    }
                  }
                } catch (imgErr) {
                  logs.push({
                    type: "post",
                    section: sectionName,
                    attempt: roundNum,
                    status: "error",
                    detail: `画像アップロードスキップ: ${imgErr.message}`,
                    timestamp: new Date().toISOString()
                  });
                }
              }

              const pubClicked = await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
                for (const b of buttons) {
                  const t = (b.innerText || "").trim();
                  const a = (b.getAttribute("aria-label") || "").toLowerCase();
                  const testid = (b.getAttribute("data-testid") || "").toLowerCase();
                  const cls = typeof b.className === "string" ? b.className : "";
                  const rect = b.getBoundingClientRect();
                  if (rect.width > 0 && rect.height > 0 && rect.x > window.innerWidth / 2) {
                    if (
                      t.includes("公開") ||
                      t.includes("Publish") ||
                      t.includes("送信") ||
                      a.includes("publish") ||
                      a.includes("submit") ||
                      a.includes("send") ||
                      testid.includes("publish") ||
                      testid.includes("submit") ||
                      cls.includes("primary") ||
                      cls.includes("submit")
                    ) {
                      b.click();
                      return true;
                    }
                  }
                }
                return false;
              });

              if (!pubClicked) {
                await page.keyboard.press("Control+Enter");
              }

              logs.push({
                type: "post",
                section: sectionName,
                attempt: roundNum,
                status: "ok",
                detail: pubClicked
                  ? `タイトル「${finalTitle}」/ メッセージ「${finalPostMsg}」送信`
                  : `ショートカット送信（タイトル「${finalTitle}」/ メッセージ「${finalPostMsg}」）`,
                timestamp: new Date().toISOString()
              });

              if (await sleepWithStop(3500, shouldStop)) {
                stoppedByUser = true;
                break;
              }
            } catch (err) {
              logs.push({
                type: "post",
                section: sectionName,
                attempt: roundNum,
                status: "error",
                detail: err && err.message ? err.message.split("\n")[0] : "投稿エラー",
                timestamp: new Date().toISOString()
              });
            }
          }
        }

        if (stoppedByUser) break;

        if (doComment) {
          for (let i = 0; i < 30; i++) {
            if (shouldStop()) {
              stoppedByUser = true;
              break;
            }

            const opened = await page.evaluate(() => {
              const allEls = Array.from(
                document.querySelectorAll('button, [role="button"], span, div')
              );
              for (const el of allEls) {
                const t = (el.innerText || "").trim();
                const a = el.getAttribute("aria-label") || "";
                if (
                  t.includes("Add comment") ||
                  t.includes("コメントを追加") ||
                  a.toLowerCase().includes("comment")
                ) {
                  const rect = el.getBoundingClientRect();
                  if (rect.width > 0 && rect.height > 0) {
                    el.click();
                    return true;
                  }
                }
              }
              return false;
            });

            if (!opened) break;

            if (await sleepWithStop(1200, shouldStop)) {
              stoppedByUser = true;
              break;
            }

            const editor = page.locator('div[contenteditable="true"], textarea').last();
            if ((await editor.count()) === 0) {
              await page.keyboard.press("Escape");
              break;
            }

            for (let r = 1; r <= cRepeat; r++) {
              if (shouldStop()) {
                stoppedByUser = true;
                break;
              }

              await setEditableValueExact(editor, finalCommentMsg);
              if (await sleepWithStop(800, shouldStop)) {
                stoppedByUser = true;
                break;
              }

              const sentByButton = await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
                for (const b of buttons) {
                  const t = (b.innerText || "").trim();
                  const a = (b.getAttribute("aria-label") || "").toLowerCase();
                  const rect = b.getBoundingClientRect();
                  if (
                    rect.width > 0 &&
                    rect.height > 0 &&
                    (t.includes("コメント") ||
                      t.includes("Comment") ||
                      a.includes("send") ||
                      a.includes("送信"))
                  ) {
                    b.click();
                    return true;
                  }
                }
                return false;
              });

              if (!sentByButton) {
                await page.keyboard.press("Enter");
              }

              logs.push({
                type: "comment",
                section: `round-${roundNum}/post-${i + 1}`,
                attempt: r,
                status: "ok",
                detail: `コメント「${finalCommentMsg}」(${r}/${cRepeat}) 送信`,
                timestamp: new Date().toISOString()
              });

              if (await sleepWithStop(2000, shouldStop)) {
                stoppedByUser = true;
                break;
              }
            }

            if (stoppedByUser) break;
          }
        }

        if (stoppedByUser) break;

        if (roundNum < totalRounds) {
          await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
          if (await sleepWithStop(5000, shouldStop)) {
            stoppedByUser = true;
            break;
          }
        }
      }
    }

    const videoObj = doVideo && page ? page.video() : null;
    if (context) {
      await context.close();
      context = null;
      page = null;
    }

    let videoBase64 = null;
    let videoFileName = null;
    if (videoObj) {
      const savedPath = await videoObj.path().catch(() => null);
      if (savedPath && fs.existsSync(savedPath)) {
        const stat = fs.statSync(savedPath);
        if (stat.size > 0 && stat.size <= MAX_VIDEO_BYTES) {
          const buf = fs.readFileSync(savedPath);
          videoBase64 = buf.toString("base64");
          videoFileName = `samon_run_${Date.now()}.webm`;
        }
      }
    }

    if (browser) {
      await browser.close();
      browser = null;
    }

    const successCount = logs.filter((l) => l.status === "ok").length;

    return res.json({
      ok: true,
      jobId,
      stopped: stoppedByUser,
      enablePost: doPost,
      enableComment: doComment,
      enableVideo: doVideo,
      detectedSections: doPost ? detectedSections : 0,
      cookiesLoaded: cookies.length,
      totalSteps: logs.length,
      successCount,
      logs,
      videoBase64,
      videoMimeType: videoBase64 ? "video/webm" : null,
      videoFileName
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      jobId,
      stopped: stoppedByUser,
      error: err && err.message ? err.message : "Playwright実行中にエラーが発生しました。",
      logs
    });
  } finally {
    activeJobs.delete(jobId);
    if (context) {
      await context.close().catch(() => {});
    }
    if (browser) {
      await browser.close().catch(() => {});
    }
    if (authFile) {
      cleanupFile(authFile);
    }
    if (videoDir) {
      cleanupDir(videoDir);
    }
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
```[cite: 3]

---

### 2. `index.html`（設定＋`run`＋途中で止める `stop` コマンド）

実行中でも入力欄から `stop`（または `cancel` / `abort` / `Esc` キー）を入力すると、`POST /stop` を送信して現在の実行を途中で止められるようにしています[cite: 4]。

```html
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Samon PowerShell</title>
  <style>
    * {
      box-sizing: border-box;
    }
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      background: #000000;
      color: #cccccc;
      font-family: "Consolas", "MS Gothic", "Courier New", monospace;
      font-size: 15px;
      line-height: 1.45;
    }
    .shell {
      min-height: 100%;
      padding: 10px 14px 28px;
      cursor: text;
    }
    .line {
      white-space: pre-wrap;
      word-break: break-word;
    }
    .cyan {
      color: #38bdf8;
    }
    .green {
      color: #4ade80;
    }
    .yellow {
      color: #facc15;
    }
    .gray {
      color: #9ca3af;
    }
    a.rec-link {
      color: #38bdf8;
      text-decoration: underline;
    }
    .prompt-row {
      display: flex;
      align-items: center;
      flex-wrap: nowrap;
      margin-top: 2px;
    }
    .prompt-label {
      color: #cccccc;
      white-space: nowrap;
      margin-right: 4px;
    }
    .cmd-input {
      flex: 1;
      min-width: 120px;
      background: transparent;
      border: none;
      outline: none;
      color: #ffffff;
      font-family: inherit;
      font-size: inherit;
      line-height: inherit;
      padding: 0;
      margin: 0;
    }
  </style>
</head>
<body>
  <div class="shell" id="shell">
    <div id="output"></div>
    <div class="prompt-row" id="promptRow">
      <span class="prompt-label" id="promptLabel">PS C:\WINDOWS\system32&gt;</span>
      <input type="text" class="cmd-input" id="cmdInput" autocomplete="off" spellcheck="false" />
    </div>
  </div>

  <script>
    const STORAGE_KEY = "samon_ps_padlet_state_v9";
    const RENDER_BASE_URL = "https://test1-1-qyfl.onrender.com/";

    const outputEl = document.getElementById("output");
    const promptRowEl = document.getElementById("promptRow");
    const promptLabelEl = document.getElementById("promptLabel");
    const cmdInput = document.getElementById("cmdInput");
    const shellEl = document.getElementById("shell");

    const defaultState = {
      apiUrl: RENDER_BASE_URL,
      roomUrl: "",
      titleMessage: "お知らせ",
      message: "メッセージ",
      commentMessage: "",
      gifFile: "_______.gif",
      cookie: "",
      repeat: 2,
      commentRepeat: 1,
      enablePost: true,
      enableComment: true,
      enableVideo: true
    };

    let state = loadState();
    if (!state.apiUrl) {
      state.apiUrl = RENDER_BASE_URL;
      saveState();
    }

    let history = [];
    let historyIdx = -1;
    let isRunning = false;
    let currentJobId = null;
    let stopRequested = false;
    let activeAbortController = null;
    const savedRecordings = [];

    function loadState() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? Object.assign({}, defaultState, JSON.parse(raw)) : Object.assign({}, defaultState);
      } catch (_) {
        return Object.assign({}, defaultState);
      }
    }

    function saveState() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch (_) {}
    }

    function appendLine(text, cls = "") {
      const div = document.createElement("div");
      div.className = "line" + (cls ? " " + cls : "");
      div.textContent = text;
      outputEl.appendChild(div);
      window.scrollTo(0, document.body.scrollHeight);
      return div;
    }

    function appendRich(parts) {
      const div = document.createElement("div");
      div.className = "line";
      parts.forEach(([txt, cls]) => {
        const span = document.createElement("span");
        if (cls) span.className = cls;
        span.textContent = txt;
        div.appendChild(span);
      });
      outputEl.appendChild(div);
      window.scrollTo(0, document.body.scrollHeight);
      return div;
    }

    function appendDownloadLink(blobUrl, fileName) {
      const div = document.createElement("div");
      div.className = "line cyan";
      const prefix = document.createTextNode("  録画ファイル保存リンク: ");
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = fileName;
      a.className = "rec-link";
      a.textContent = fileName;
      div.appendChild(prefix);
      div.appendChild(a);
      outputEl.appendChild(div);
      window.scrollTo(0, document.body.scrollHeight);
    }

    function saveRecordingToBrowser(base64Str, mimeType = "video/webm", fileName = "samon_run.webm") {
      const binStr = atob(base64Str);
      const len = binStr.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binStr.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: mimeType });
      const blobUrl = URL.createObjectURL(blob);

      savedRecordings.push({
        fileName,
        blobUrl,
        sizeKB: Math.round(bytes.length / 1024),
        savedAt: new Date().toISOString()
      });

      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      appendLine(`  録画を保存しました: ${fileName} (${Math.round(bytes.length / 1024)} KB)`, "green");
      appendDownloadLink(blobUrl, fileName);
    }

    function printBanner() {
      appendLine("Samon PowerShell");
      appendLine("Copyright (C) Microsoft Corporation. All rights reserved.");
      appendLine("");
      appendRich([
        ["実行中に途中で止めたい場合は ", ""],
        ["stop", "yellow"],
        [" と入力するか ", ""],
        ["Esc", "yellow"],
        [" を押してください。", ""]
      ]);
      appendLine("");
      appendRich([
        ["コマンド一覧は ", ""],
        ["help", "cyan"],
        ["、画面消去は ", ""],
        ["cls", "cyan"],
        [" と入力してください。", ""]
      ]);
      appendLine("");
    }

    function sleep(ms) {
      return new Promise((r) => setTimeout(r, ms));
    }

    function updatePromptState() {
      promptRowEl.style.display = "flex";
      cmdInput.disabled = false;
      promptLabelEl.textContent = isRunning
        ? "PS [RUNNING - stopで中断]> "
        : "PS C:\\WINDOWS\\system32> ";
      cmdInput.focus();
    }

    function tokenize(raw) {
      const tokens = [];
      const regex = /[^\s"]+|"([^"]*)"/g;
      let match;
      while ((match = regex.exec(raw)) !== null) {
        tokens.push(match[1] !== undefined ? match[1] : match[0]);
      }
      return tokens;
    }

    function stripOuterQuotes(str) {
      const s = str.trim();
      if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
        return s.slice(1, -1);
      }
      return s;
    }

    function parseToggle(val) {
      const v = String(val || "").trim().toLowerCase();
      if (["on", "true", "1", "yes", "enable"].includes(v)) return true;
      if (["off", "false", "0", "no", "disable"].includes(v)) return false;
      return null;
    }

    async function requestStopJob() {
      if (!isRunning) {
        appendLine("現在実行中の処理はありません。", "gray");
        return;
      }
      stopRequested = true;
      const endpoint = (state.apiUrl || RENDER_BASE_URL).replace(/\/+$/, "") + "/stop";
      appendLine("中断リクエストを送信しました（現在の待機・ステップ完了後に停止します）...", "yellow");

      try {
        await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jobId: currentJobId })
        });
      } catch (_) {}

      setTimeout(() => {
        if (isRunning && stopRequested && activeAbortController) {
          activeAbortController.abort();
        }
      }, 4000);
    }

    async function runBotSequence() {
      if (isRunning) {
        appendLine("すでに実行中です。止めるには stop と入力してください。", "yellow");
        return;
      }

      if (!state.roomUrl) {
        appendLine("エラー: roomUrl が未設定です。先に set-url <URL> を実行してください。", "yellow");
        appendLine("");
        return;
      }

      if (!state.enablePost && !state.enableComment) {
        appendLine("エラー: 投稿とコメントが両方 OFF です。set-post on または set-comment on を設定してください。", "yellow");
        appendLine("");
        return;
      }

      const endpoint = (state.apiUrl || RENDER_BASE_URL).replace(/\/+$/, "") + "/run";
      isRunning = true;
      stopRequested = false;
      currentJobId =
        window.crypto && typeof window.crypto.randomUUID === "function"
          ? window.crypto.randomUUID()
          : "job_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
      updatePromptState();

      const startedAt = Date.now();
      appendLine("Render サーバーへリクエストを送信中...", "cyan");
      appendLine("Job ID         : " + currentJobId, "gray");
      appendLine("Endpoint       : " + endpoint, "gray");
      appendLine("Room URL       : " + state.roomUrl, "gray");
      appendLine("Title          : " + (state.titleMessage || "お知らせ"), "gray");
      appendLine("Message        : " + (state.message || "メッセージ"), "gray");
      appendLine("Image / GIF    : " + (state.gifFile || "_______.gif"), "gray");
      if (state.enableComment) {
        appendLine("Comment Msg    : " + (state.commentMessage || state.message || "メッセージ"), "gray");
        appendLine("Comment Repeat : " + state.commentRepeat + " 回/投稿", "gray");
      }
      if (state.enablePost) {
        appendLine("Rounds         : " + state.repeat + " ラウンド", "gray");
      }
      appendLine("");

      const progressLine = appendLine("  [待機中] Playwright 実行中... (0秒経過)", "gray");
      const progressTimer = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startedAt) / 1000);
        const tag = stopRequested ? "[中断要求中]" : "[待機中]";
        progressLine.textContent = `  ${tag} Playwright 実行中... (${elapsed}秒経過)`;
        window.scrollTo(0, document.body.scrollHeight);
      }, 1000);

      activeAbortController = new AbortController();
      const timeoutId = setTimeout(() => activeAbortController.abort(), 600000);

      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          signal: activeAbortController.signal,
          body: JSON.stringify({
            jobId: currentJobId,
            roomUrl: state.roomUrl,
            titleMessage: state.titleMessage,
            message: state.message,
            commentMessage: state.commentMessage,
            gifFile: state.gifFile,
            cookie: state.cookie,
            repeat: state.repeat,
            commentRepeat: state.commentRepeat,
            enablePost: state.enablePost,
            enableComment: state.enableComment,
            enableVideo: state.enableVideo
          })
        });

        clearTimeout(timeoutId);
        clearInterval(progressTimer);

        const rawText = await res.text();
        let data = null;
        try {
          data = JSON.parse(rawText);
        } catch (_) {
          progressLine.textContent = `  [応答受信] HTTP ${res.status} (非JSON応答)`;
          progressLine.className = "line yellow";
          appendLine("サーバー応答（生テキスト）: " + rawText, "yellow");
          appendLine("");
          return;
        }

        const totalSec = ((Date.now() - startedAt) / 1000).toFixed(1);
        progressLine.textContent = data.stopped
          ? `  [中断完了] HTTP ${res.status} (${totalSec}秒で停止)`
          : `  [応答受信] HTTP ${res.status} (${totalSec}秒で完了)`;
        progressLine.className = res.ok && data.ok ? (data.stopped ? "line yellow" : "line cyan") : "line yellow";

        if (Array.isArray(data.logs) && data.logs.length > 0) {
          appendLine("--- 実行ログ一覧 ---", "cyan");
          for (const item of data.logs) {
            await sleep(40);
            const isOk = item.status !== "error";
            const tag = item.type === "comment" ? "COMMENT" : "POST";
            const statusText = item.detail ? ` - ${item.detail}` : "";
            appendLine(
              `  -> [${tag}][${item.section}] ${item.attempt} 回目${statusText} (${item.timestamp || ""})`,
              isOk ? "green" : "yellow"
            );
          }
        } else {
          appendLine("  (サーバーからの詳細ログ配列は空です)", "gray");
        }

        if (data.videoBase64) {
          saveRecordingToBrowser(
            data.videoBase64,
            data.videoMimeType || "video/webm",
            data.videoFileName || `samon_run_${Date.now()}.webm`
          );
        } else if (state.enableVideo) {
          appendLine("  (録画データは含まれていませんでした)", "gray");
        }

        if (!res.ok || !data.ok) {
          appendLine("エラー: " + (data.error || "HTTP " + res.status), "yellow");
          appendLine("");
          return;
        }

        if (data.stopped) {
          appendLine("途中で停止しました。", "yellow");
        }

        const sectionInfo = state.enablePost ? `検出セクション: ${data.detectedSections ?? 1} / ` : "";
        appendLine(
          `${sectionInfo}読込Cookie: ${data.cookiesLoaded ?? 0} 件 / 成功: ${data.successCount ?? 0} / 合計: ${data.totalSteps ?? 0}`,
          "cyan"
        );
        appendLine("");
      } catch (err) {
        clearTimeout(timeoutId);
        clearInterval(progressTimer);
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

        if (stopRequested) {
          progressLine.textContent = `  [中断完了] ${elapsed}秒経過時点で停止しました`;
          progressLine.className = "line yellow";
          appendLine("コマンドの実行を途中で停止しました。", "yellow");
          appendLine("");
          return;
        }

        progressLine.textContent = `  [通信中断] ${elapsed}秒経過時点でエラー発生`;
        progressLine.className = "line yellow";
        appendLine("通信エラー: " + (err && err.message ? err.message : String(err)), "yellow");
        appendLine("");
      } finally {
        isRunning = false;
        currentJobId = null;
        stopRequested = false;
        activeAbortController = null;
        updatePromptState();
      }
    }

    async function handleCommand(rawLine) {
      const trimmed = rawLine.trim();
      appendLine(promptLabelEl.textContent + rawLine);

      if (!trimmed) return;

      history.push(rawLine);
      historyIdx = history.length;

      const tokens = tokenize(trimmed);
      const cmd = tokens[0].toLowerCase();
      const argText = trimmed.slice(tokens[0].length).trim();

      if (cmd === "stop" || cmd === "cancel" || cmd === "abort") {
        await requestStopJob();
        return;
      }

      if (isRunning) {
        appendLine("実行中です。途中で止める場合は stop と入力してください。", "yellow");
        return;
      }

      if (cmd === "cls" || cmd === "clear") {
        outputEl.innerHTML = "";
        return;
      }

      if (cmd === "reset-config") {
        state = Object.assign({}, defaultState);
        saveState();
        appendLine("設定を初期値にリセットしました。", "green");
        return;
      }

      if (cmd === "help") {
        appendLine("利用可能なコマンド:", "cyan");
        appendLine("  help                   コマンド一覧を表示");
        appendLine("  cls                    画面をクリア");
        appendLine("  config                 現在の設定を表示");
        appendLine("  reset-config           設定を初期値に戻す");
        appendLine("  recordings             取得した録画一覧を表示");
        appendLine("  set-post <on|off>      投稿処理の有効/無効（既定: on）");
        appendLine("  set-comment <on|off>   コメント処理の有効/無効（既定: on）");
        appendLine("  set-rec <on|off>       録画保存の有効/無効（既定: on）");
        appendLine("  set-api <URL>          Renderエンドポイントを設定");
        appendLine("  set-url <URL>          対象ボードのURLを設定");
        appendLine("  set-title <TEXT>       決められた投稿タイトルを設定");
        appendLine("  set-msg <TEXT>         決められた投稿メッセージを設定");
        appendLine("  set-cmsg <TEXT>        決められたコメントメッセージを設定");
        appendLine("  set-gif <FILENAME>     使用する画像/GIFファイル名を設定（既定: _______.gif）");
        appendLine("  set-crepeat <NUM>      1投稿あたりのコメント回数（1〜10）");
        appendLine("  set-cookie <VALUE>     Cookie（JSON配列または key=val）を設定");
        appendLine("  clear-cookie           保存済みCookieを削除");
        appendLine("  set-repeat <NUM>       ラウンド数（1〜10、既定: 2）");
        appendLine("  run                    設定内容で実行");
        appendLine("  stop                   実行中の処理を途中で停止（Escキーでも可）");
        appendLine("");
        return;
      }

      if (cmd === "recordings") {
        if (savedRecordings.length === 0) {
          appendLine("保存された録画はまだありません。", "gray");
          appendLine("");
          return;
        }
        appendLine("保存済み録画一覧:", "cyan");
        savedRecordings.forEach((rec, idx) => {
          appendLine(`  [${idx + 1}] ${rec.fileName} (${rec.sizeKB} KB) - ${rec.savedAt}`, "green");
          appendDownloadLink(rec.blobUrl, rec.fileName);
        });
        appendLine("");
        return;
      }

      if (cmd === "config") {
        appendLine("現在の設定:", "cyan");
        appendLine("  apiUrl        : " + (state.apiUrl || RENDER_BASE_URL));
        appendLine("  roomUrl       : " + (state.roomUrl || "(未設定)"));
        appendLine("  post          : " + (state.enablePost ? "ON" : "OFF"));
        appendLine("  comment       : " + (state.enableComment ? "ON" : "OFF"));
        appendLine("  record        : " + (state.enableVideo ? "ON" : "OFF"));
        appendLine("  titleMessage  : " + (state.titleMessage || "お知らせ"));
        appendLine("  message       : " + (state.message || "メッセージ"));
        appendLine("  commentMsg    : " + (state.commentMessage || "(未設定 -> messageを使用)"));
        appendLine("  gifFile       : " + (state.gifFile || "_______.gif"));
        appendLine("  commentRepeat : " + state.commentRepeat);
        appendLine("  cookie        : " + (state.cookie ? `設定済み (${state.cookie.length} 文字)` : "(未設定)"));
        appendLine("  repeat        : " + state.repeat);
        appendLine("");
        return;
      }

      if (cmd === "set-post") {
        const parsed = parseToggle(tokens[1]);
        if (parsed === null) {
          appendLine("on または off を指定してください。", "yellow");
          return;
        }
        state.enablePost = parsed;
        saveState();
        appendLine("投稿モードを " + (parsed ? "ON" : "OFF") + " に設定しました。", "green");
        return;
      }

      if (cmd === "set-comment") {
        const parsed = parseToggle(tokens[1]);
        if (parsed === null) {
          appendLine("on または off を指定してください。", "yellow");
          return;
        }
        state.enableComment = parsed;
        saveState();
        appendLine("コメントモードを " + (parsed ? "ON" : "OFF") + " に設定しました。", "green");
        return;
      }

      if (cmd === "set-rec") {
        const parsed = parseToggle(tokens[1]);
        if (parsed === null) {
          appendLine("on または off を指定してください。", "yellow");
          return;
        }
        state.enableVideo = parsed;
        saveState();
        appendLine("録画モードを " + (parsed ? "ON" : "OFF") + " に設定しました。", "green");
        return;
      }

      if (cmd === "set-api") {
        const nextUrl = stripOuterQuotes(tokens[1] || argText);
        if (!nextUrl) {
          appendLine("URLを指定してください。", "yellow");
          return;
        }
        state.apiUrl = nextUrl;
        saveState();
        appendLine("apiUrl を更新しました: " + state.apiUrl, "green");
        return;
      }

      if (cmd === "set-url") {
        const nextRoom = stripOuterQuotes(tokens[1] || argText);
        if (!nextRoom) {
          appendLine("URLを指定してください。", "yellow");
          return;
        }
        state.roomUrl = nextRoom;
        saveState();
        appendLine("roomUrl を更新しました: " + state.roomUrl, "green");
        return;
      }

      if (cmd === "set-title") {
        state.titleMessage = stripOuterQuotes(argText);
        saveState();
        appendLine("titleMessage を更新しました: " + state.titleMessage, "green");
        return;
      }

      if (cmd === "set-msg") {
        state.message = stripOuterQuotes(argText);
        saveState();
        appendLine("message を更新しました: " + state.message, "green");
        return;
      }

      if (cmd === "set-cmsg") {
        state.commentMessage = stripOuterQuotes(argText);
        saveState();
        appendLine("commentMessage を更新しました: " + state.commentMessage, "green");
        return;
      }

      if (cmd === "set-gif" || cmd === "set-image") {
        state.gifFile = stripOuterQuotes(argText);
        saveState();
        appendLine("gifFile を更新しました: " + state.gifFile, "green");
        return;
      }

      if (cmd === "set-crepeat") {
        const n = parseInt(tokens[1], 10);
        if (!Number.isFinite(n) || n < 1 || n > 10) {
          appendLine("1〜10の整数を指定してください。", "yellow");
          return;
        }
        state.commentRepeat = n;
        saveState();
        appendLine("commentRepeat を " + n + " に設定しました。", "green");
        return;
      }

      if (cmd === "set-cookie") {
        const rawCookie = argText.trim();
        if (!rawCookie) {
          appendLine("Cookie文字列またはJSONを指定してください。", "yellow");
          return;
        }
        state.cookie =
          rawCookie.startsWith("[") || rawCookie.startsWith("{")
            ? rawCookie
            : stripOuterQuotes(rawCookie);
        saveState();
        appendLine("cookie を更新しました。", "green");
        return;
      }

      if (cmd === "clear-cookie") {
        state.cookie = "";
        saveState();
        appendLine("cookie を削除しました。", "green");
        return;
      }

      if (cmd === "set-repeat") {
        const n = parseInt(tokens[1], 10);
        if (!Number.isFinite(n) || n < 1 || n > 10) {
          appendLine("1〜10の整数を指定してください。", "yellow");
          return;
        }
        state.repeat = n;
        saveState();
        appendLine("repeat を " + n + " に設定しました。", "green");
        return;
      }

      if (cmd === "run") {
        await runBotSequence();
        return;
      }

      appendLine(
        cmd +
          " : 用語 '" +
          cmd +
          "' は、コマンドレット、関数、スクリプト ファイル、または操作可能なプログラムの名前として認識されません。",
        "yellow"
      );
      appendLine("");
    }

    cmdInput.addEventListener("keydown", async (e) => {
      if (e.key === "Escape" && isRunning) {
        e.preventDefault();
        appendLine(promptLabelEl.textContent + "stop (Esc)");
        await requestStopJob();
        return;
      }

      if (e.key === "Enter") {
        const val = cmdInput.value;
        cmdInput.value = "";
        await handleCommand(val);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (historyIdx > 0) {
          historyIdx -= 1;
          cmdInput.value = history[historyIdx];
        }
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        if (historyIdx < history.length - 1) {
          historyIdx += 1;
          cmdInput.value = history[historyIdx];
        } else {
          historyIdx = history.length;
          cmdInput.value = "";
        }
      }
    });

    shellEl.addEventListener("click", () => {
      cmdInput.focus();
    });

    window.addEventListener("DOMContentLoaded", () => {
      printBanner();
      updatePromptState();
    });
  </script>
</body>
</html>
```[cite: 4]

---

### 使い方の例
```text
set-url https://padlet.com/example/board
set-title 決まったタイトル
set-msg 決まったメッセージ
set-cmsg 決まったコメント
set-gif _______.gif
run
