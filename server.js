const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { runPosts } = require("./post");
const { runComments } = require("./comment");

const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
  })
);
app.use(express.json({ limit: "2mb" }));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function downloadGifToTemp(gifUrl) {
  if (!gifUrl || !/^https?:\/\//i.test(gifUrl.trim())) return null;
  try {
    const res = await fetch(gifUrl.trim());
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) return null;
    const tmpFile = path.join(os.tmpdir(), `padlet_gif_${Date.now()}.gif`);
    fs.writeFileSync(tmpFile, buf);
    return tmpFile;
  } catch (_) {
    return null;
  }
}

function cleanupDir(dirPath) {
  if (!dirPath || !fs.existsSync(dirPath)) return;
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch (_) {}
}

async function waitForBoardReady(page, timeoutMs = 35000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
      return btns.some((b) => {
        const r = b.getBoundingClientRect();
        const t = (b.innerText || "").trim();
        const a = (b.getAttribute("aria-label") || "").toLowerCase();
        return (
          r.width > 0 &&
          r.height > 0 &&
          (t === "+" || t.includes("投稿") || a.includes("add") || a.includes("post"))
        );
      });
    });
    if (ready) {
      await sleep(1500);
      return true;
    }
    await sleep(1000);
  }
  return false;
}

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});

app.get("/", (req, res) => {
  res.json({ status: "ok", mode: "playwright-ready" });
});

app.post("/run", async (req, res) => {
  const {
    roomUrl = "",
    message = "",
    commentMessage = "",
    gifUrl = "",
    cookie = "",
    repeat = 2,
    commentRepeat = 1,
    enablePost = true,
    enableComment = false,
    enableVideo = true
  } = req.body || {};

  const trimmedUrl = roomUrl.trim();
  if (!trimmedUrl) {
    return res.status(400).json({ ok: false, error: "roomUrl が指定されていません。" });
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

  const count = Math.max(1, Math.min(10, Number(repeat) || 2));
  const cRepeat = Math.max(1, Math.min(10, Number(commentRepeat) || 1));
  const logs = [];
  let browser;
  let context;
  let page;
  let gifFilePath = null;
  let detectedSections = 0;
  const videoDir = doVideo ? fs.mkdtempSync(path.join(os.tmpdir(), "padlet_rec_")) : null;

  try {
    if (doPost) {
      gifFilePath = await downloadGifToTemp(gifUrl);
    }

    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--single-process",
        "--no-zygote"
      ]
    });

    const contextOptions = {
      viewport: { width: 1280, height: 720 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36"
    };

    if (doVideo && videoDir) {
      contextOptions.recordVideo = {
        dir: videoDir,
        size: { width: 800, height: 450 }
      };
    }

    context = await browser.newContext(contextOptions);

    const cookies = normalizeCookies(cookie, trimmedUrl);
    if (cookies.length > 0) {
      await context.addCookies(cookies);
    }

    page = await context.newPage();
    await page.goto(trimmedUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await waitForBoardReady(page, 35000);

    if (doPost) {
      const postResult = await runPosts(page, {
        message,
        gifFilePath,
        repeat: count
      });
      detectedSections = postResult.detectedSections;
      logs.push(...postResult.logs);
    }

    if (doComment) {
      if (doPost) {
        await sleep(1500);
      }
      const commentResult = await runComments(page, {
        message,
        commentMessage,
        commentRepeat: cRepeat,
        maxPosts: 20
      });
      logs.push(...commentResult.logs);
    }

    const videoObj = doVideo ? page.video() : null;
    await page.close();
    await context.close();
    context = null;

    let videoBase64 = null;
    let videoFileName = null;
    if (videoObj) {
      const savedPath = await videoObj.path().catch(() => null);
      if (savedPath && fs.existsSync(savedPath)) {
        const stat = fs.statSync(savedPath);
        // 巨大すぎる動画でレスポンスが肥大化するのを防ぐ（約8MBまで）
        if (stat.size > 0 && stat.size <= 25 * 1024 * 1024) {
          const buf = fs.readFileSync(savedPath);
          videoBase64 = buf.toString("base64");
          videoFileName = `samon_run_${Date.now()}.webm`;
        }
      }
    }

    await browser.close();
    browser = null;

    const successCount = logs.filter((l) => l.status === "ok").length;

    return res.json({
      ok: true,
      enablePost: doPost,
      enableComment: doComment,
      enableVideo: doVideo,
      detectedSections,
      cookiesLoaded: cookies.length,
      totalSteps: logs.length,
      successCount,
      logs,
      videoBase64,
      videoMimeType: videoBase64 ? "video/webm" : null,
      videoFileName
    });
  } catch (err) {
    if (context) {
      try {
        await context.close();
      } catch (_) {}
    }
    if (browser) {
      try {
        await browser.close();
      } catch (_) {}
    }
    return res.status(500).json({
      ok: false,
      error: err && err.message ? err.message : "Playwright実行中にエラーが発生しました。",
      logs
    });
  } finally {
    if (videoDir) cleanupDir(videoDir);
    if (gifFilePath && fs.existsSync(gifFilePath)) {
      try {
        fs.unlinkSync(gifFilePath);
      } catch (_) {}
    }
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
