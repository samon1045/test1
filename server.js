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
const MAX_VIDEO_BYTES = 35 * 1024 * 1024; // 通信断・メモリ圧迫を防ぐため35MB上限

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

function resolveLocalGifPath() {
  const candidates = [
    path.join(__dirname, "_______.gif"),
    path.join(__dirname, "_______ (3).gif"),
    path.join(__dirname, "image.gif")
  ];

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

async function waitForPadletBoardReady(page, shouldStop, maxWaitMs = 40000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (shouldStop()) return { ready: false, stopped: true };

    const isReady = await page.evaluate(() => {
      const textAll = (document.body && document.body.innerText) || "";
      if (textAll.includes("セクション") || textAll.includes("投稿")) {
        const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
        return btns.some((b) => {
          const r = b.getBoundingClientRect();
          const t = (b.innerText || "").trim();
          const a = (b.getAttribute("aria-label") || "").toLowerCase();
          return (
            r.width > 0 &&
            r.height > 0 &&
            (t.includes("投稿") || t === "+" || a.includes("add") || a.includes("post"))
          );
        });
      }
      return false;
    });

    if (isReady) {
      const stopped = await sleepWithStop(1200, shouldStop);
      return { ready: true, stopped };
    }

    const stopped = await sleepWithStop(800, shouldStop);
    if (stopped) return { ready: false, stopped: true };
  }

  return { ready: false, stopped: shouldStop() };
}

async function inspectSections(page) {
  return page.evaluate(() => {
    const headings = Array.from(document.querySelectorAll("h1, h2, h3, h4, div, span, p"));
    const sectionTitles = [];
    for (const el of headings) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0 || r.y < 0 || r.y > 450) continue;
      const t = (el.innerText || "").trim();
      if (/^セクション\s*\d+$/i.test(t) && !sectionTitles.includes(t)) {
        sectionTitles.push(t);
      }
    }
    return { sectionTitles };
  });
}

async function clickAddButtonForSection(page, secIdx, sectionTitle) {
  const clicked = await page.evaluate((idx) => {
    const allBtns = Array.from(
      document.querySelectorAll('button, [role="button"], [data-testid*="add"]')
    );
    const addButtons = allBtns.filter((btn) => {
      const r = btn.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const t = (btn.innerText || "").trim();
      const a = (btn.getAttribute("aria-label") || "").toLowerCase();
      const testid = (btn.getAttribute("data-testid") || "").toLowerCase();
      return (
        t === "+" ||
        t.includes("投稿") ||
        t.includes("Add") ||
        t.includes("追加") ||
        a.includes("add") ||
        a.includes("post") ||
        a.includes("追加") ||
        a.includes("投稿") ||
        testid.includes("add") ||
        testid.includes("post")
      );
    });

    if (addButtons.length === 0) return false;
    const target = addButtons.length > 1 && addButtons[idx] ? addButtons[idx] : addButtons[0];
    target.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
    target.click();
    return true;
  }, secIdx);

  if (!clicked) return false;

  if (sectionTitle) {
    await sleep(500);
    await page.evaluate((targetTitle) => {
      const items = Array.from(
        document.querySelectorAll('button, [role="button"], [role="option"], li, div, span')
      );
      for (const el of items) {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        const t = (el.innerText || "").trim();
        if (t === targetTitle) {
          const clickable = el.closest('button, [role="button"], [role="option"], li') || el;
          clickable.click();
          return true;
        }
      }
      return false;
    }, sectionTitle);
  }

  return true;
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
    console.log(`[STOP] jobId=${jobId}`);
    return res.json({ ok: true, stopped: true, jobId });
  }
  let stoppedCount = 0;
  for (const [, job] of activeJobs.entries()) {
    job.stopped = true;
    stoppedCount++;
  }
  console.log(`[STOP] all count=${stoppedCount}`);
  return res.json({ ok: true, stopped: stoppedCount > 0, stoppedCount });
});

app.post("/run", async (req, res) => {
  const {
    jobId: reqJobId = "",
    roomUrl = "",
    cookie = "",
    repeat = 2,
    commentRepeat = 1,
    enablePost = true,
    enableComment = true,
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

  const titleMessage = "お知らせ";
  const customMessage = "メッセージ";
  const commentMessage = "メッセージ";
  const imagePath = resolveLocalGifPath();

  const logs = [];
  let browser = null;
  let context = null;
  let page = null;
  let authFile = null;
  let detectedSections = 0;
  let stoppedByUser = false;

  const videoDir = doVideo ? fs.mkdtempSync(path.join(os.tmpdir(), "padlet_rec_")) : null;
  console.log(`[RUN START] jobId=${jobId} rounds=${totalRounds} post=${doPost} comment=${doComment} video=${doVideo}`);

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
      const boardWait = await waitForPadletBoardReady(page, shouldStop, 40000);
      stoppedByUser = boardWait.stopped;
    }

    if (!stoppedByUser) {
      for (let roundNum = 1; roundNum <= totalRounds; roundNum++) {
        if (shouldStop()) {
          stoppedByUser = true;
          break;
        }
        console.log(`[ROUND ${roundNum}/${totalRounds}] jobId=${jobId}`);

        if (doPost) {
          const info = await inspectSections(page);
          const loopCount = Math.max(info.sectionTitles.length, 1);
          detectedSections = loopCount;

          for (let secIdx = 0; secIdx < loopCount; secIdx++) {
            if (shouldStop()) {
              stoppedByUser = true;
              break;
            }

            const sectionTitle = info.sectionTitles[secIdx] || `セクション${secIdx + 1}`;
            const sectionName = `Section ${secIdx + 1}`;
            try {
              const clickedAdd = await clickAddButtonForSection(page, secIdx, sectionTitle);

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
                await setEditableValueExact(editables.nth(0), titleMessage);
              }
              if (editableCount > 1) {
                await setEditableValueExact(editables.nth(1), customMessage);
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
                  ? `${sectionTitle} へ投稿を送信しました`
                  : `${sectionTitle} へショートカットで投稿を送信しました`,
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

              await setEditableValueExact(editor, commentMessage);
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
                detail: `コメント送信 (${r}/${cRepeat})`,
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
          const reloadWait = await waitForPadletBoardReady(page, shouldStop, 40000);
          stoppedByUser = reloadWait.stopped;
          if (stoppedByUser) break;
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
    console.log(`[RUN DONE] jobId=${jobId} stopped=${stoppedByUser} steps=${logs.length}`);

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
    console.error(`[RUN ERROR] jobId=${jobId}`, err);
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
