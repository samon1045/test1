const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { runPosts } = require("./post");
const { runComments } = require("./comment");
const { sleep, cleanupDir } = require("./utils");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const MAX_VIDEO_BYTES = 80 * 1024 * 1024; // 80MBまでBase64返却を許容

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

async function waitForBoardReady(page, timeoutMs = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await page.evaluate(() => {
      const bodyLen = (document.body?.innerText || "").trim().length;
      if (bodyLen === 0) return false;

      const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
      const hasActionBtn = btns.some((b) => {
        const r = b.getBoundingClientRect();
        const t = (b.innerText || "").trim();
        const a = (b.getAttribute("aria-label") || "").toLowerCase();
        return (
          r.width > 0 &&
          r.height > 0 &&
          (t === "+" ||
            t.includes("投稿") ||
            a.includes("add") ||
            a.includes("post") ||
            a.includes("comment"))
        );
      });

      return hasActionBtn || bodyLen > 120;
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

  const count = Math.max(1, Math.min(10, Number(repeat) || 2));
  const cRepeat = Math.max(1, Math.min(10, Number(commentRepeat) || 1));
  const logs = [];
  let browser = null;
  let context = null;
  let page = null;
  let detectedSections = 0;
  const videoDir = doVideo ? fs.mkdtempSync(path.join(os.tmpdir(), "padlet_rec_")) : null;

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-blink-features=AutomationControlled",
        "--no-zygote"
      ]
    });

    const contextOptions = {
      viewport: { width: 1280, height: 720 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
      extraHTTPHeaders: {
        "Accept-Language": "ja,en-US;q=0.9,en;q=0.8"
      }
    };

    if (doVideo && videoDir) {
      contextOptions.recordVideo = {
        dir: videoDir,
        size: { width: 800, height: 450 }
      };
    }

    context = await browser.newContext(contextOptions);

    const cookies = normalizeCookies(cookie, parsedUrl.toString());
    if (cookies.length > 0) {
      await context.addCookies(cookies);
    }

    page = await context.newPage();
    await page.goto(parsedUrl.toString(), { waitUntil: "domcontentloaded", timeout: 60000 });
    await waitForBoardReady(page, 25000);

    if (doPost) {
      const postResult = await runPosts(page, {
        message,
        gifUrl,
        repeat: count,
        waitForBoardReady
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
        maxPosts: 25
      });
      logs.push(...commentResult.logs);
    }

    const videoObj = doVideo && page ? page.video() : null;
    if (context) {
      await context.close();
      context = null;
      page = null;
    }

    let videoBase64 = null;
    let videoFileName = null;
    let videoSkippedReason = null;

    if (videoObj) {
      const savedPath = await videoObj.path().catch(() => null);
      if (savedPath && fs.existsSync(savedPath)) {
        const stat = fs.statSync(savedPath);
        if (stat.size > 0 && stat.size <= MAX_VIDEO_BYTES) {
          const buf = fs.readFileSync(savedPath);
          videoBase64 = buf.toString("base64");
          videoFileName = `samon_run_${Date.now()}.webm`;
        } else if (stat.size > MAX_VIDEO_BYTES) {
          videoSkippedReason = `録画サイズが上限（${Math.round(MAX_VIDEO_BYTES / (1024 * 1024))}MB）を超過しました`;
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
      videoFileName,
      videoSkippedReason
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err && err.message ? err.message : "Playwright実行中にエラーが発生しました。",
      logs
    });
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
    if (browser) {
      await browser.close().catch(() => {});
    }
    if (videoDir) {
      cleanupDir(videoDir);
    }
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
