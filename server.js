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
const MAX_VIDEO_BYTES = 35 * 1024 * 1024;
const MAX_JOB_DURATION_MS = 150000; // Renderの接続断(約180-300秒)前に必ずJSONを返す上限

const activeJobs = new Map();

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
  })
);
app.use(express.json({ limit: "2mb" }));

function withTimeout(promise, ms, fallbackValue = null) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise)
      .catch(() => fallbackValue)
      .finally(() => {
        if (timer) clearTimeout(timer);
      }),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallbackValue), ms);
    })
  ]);
}

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
  await withTimeout(locator.scrollIntoViewIfNeeded(), 2000, null);
  await withTimeout(locator.click(), 3000, null);
  await withTimeout(locator.fill(text), 3000, null);
}

async function waitForPostEditor(page, shouldStop, maxWaitMs = 6000) {
  const selector =
    'textarea:visible, div[contenteditable="true"]:visible, input[type="text"]:visible, [role="textbox"]:visible';
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (shouldStop()) return null;
    const loc = page.locator(selector);
    const cnt = await withTimeout(loc.count(), 1500, 0);
    if (cnt > 0) {
      const visible = await withTimeout(loc.first().isVisible(), 1500, false);
      if (visible) return loc;
    }
    await sleep(250);
  }
  return null;
}

async function findCommentEditorLocator(page, maxWaitMs = 4000) {
  const selector =
    'textarea:visible, div[contenteditable="true"]:visible, input[type="text"]:visible, [role="textbox"]:visible';
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    const loc = page.locator(selector);
    const cnt = await withTimeout(loc.count(), 1500, 0);

    if (cnt > 0) {
      let bestIdx = -1;
      let bestScore = -9999;

      for (let i = 0; i < cnt; i++) {
        const item = loc.nth(i);
        const info = await withTimeout(
          item.evaluate((el) => {
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) return null;

            const ph = (el.getAttribute("placeholder") || "").toLowerCase();
            const aria = (el.getAttribute("aria-label") || "").toLowerCase();
            const dataPh = (el.getAttribute("data-placeholder") || "").toLowerCase();
            const container = el.closest(
              '[role="dialog"], [class*="comment"], [class*="Comment"], [class*="modal"], [class*="Modal"], form, aside'
            );
            const containerText = ((container && container.innerText) || "").toLowerCase();

            const isCommentHint =
              ph.includes("comment") ||
              ph.includes("コメント") ||
              aria.includes("comment") ||
              aria.includes("コメント") ||
              dataPh.includes("comment") ||
              dataPh.includes("コメント") ||
              containerText.includes("add comment") ||
              containerText.includes("コメントを追加") ||
              containerText.includes("comments") ||
              containerText.includes("コメント");

            return {
              isCommentHint,
              hasContainer: Boolean(container),
              y: r.y
            };
          }),
          1500,
          null
        );

        if (!info) continue;

        let score = 0;
        if (info.isCommentHint) score += 200;
        if (info.hasContainer) score += 40;
        if (info.y > 100) score += 10;

        if (score > bestScore) {
          bestScore = score;
          bestIdx = i;
        }
      }

      if (bestIdx >= 0 && bestScore >= 200) {
        return loc.nth(bestIdx);
      }
    }

    await sleep(250);
  }

  return null;
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

async function waitForPadletBoardReady(page, shouldStop, maxWaitMs = 35000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (shouldStop()) return { ready: false, stopped: true };

    const isReady = await withTimeout(
      page.evaluate(() => {
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
      }),
      2000,
      false
    );

    if (isReady) {
      const stopped = await sleepWithStop(1000, shouldStop);
      return { ready: true, stopped };
    }

    const stopped = await sleepWithStop(700, shouldStop);
    if (stopped) return { ready: false, stopped: true };
  }

  return { ready: false, stopped: shouldStop() };
}

async function inspectSections(page) {
  return withTimeout(
    page.evaluate(() => {
      const headings = Array.from(document.querySelectorAll("h1, h2, h3, h4, div, span, p"));
      const seen = new Set();
      const sections = [];

      for (const el of headings) {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0 || r.y < 0 || r.y > 500) continue;
        const t = (el.innerText || "").trim();
        if (/^セクション\s*\d+$/i.test(t) && !seen.has(t)) {
          seen.add(t);
          sections.push({
            title: t,
            centerX: r.left + r.width / 2
          });
        }
      }

      sections.sort((a, b) => a.centerX - b.centerX);
      return { sections };
    }),
    2500,
    { sections: [] }
  );
}

async function selectSectionInOpenComposer(page, sectionTitle) {
  if (!sectionTitle) return false;

  // 1. フォーム内のセクション選択トリガー（現在選択中のセクション名や「セクション」ボタン）を開く
  const openedTrigger = await withTimeout(
    page.evaluate(() => {
      const candidates = Array.from(
        document.querySelectorAll(
          '[role="dialog"] button, [role="dialog"] [role="button"], form button, form [role="button"], [class*="composer"] button, [class*="Composer"] button, [class*="modal"] button, [class*="Modal"] button'
        )
      );

      for (const btn of candidates) {
        const r = btn.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        const t = (btn.innerText || "").trim();
        const a = (btn.getAttribute("aria-label") || "").toLowerCase();
        if (
          /^セクション\s*\d+$/i.test(t) ||
          a.includes("section") ||
          a.includes("セクション")
        ) {
          btn.click();
          return true;
        }
      }
      return false;
    }),
    2000,
    false
  );

  if (openedTrigger) {
    await sleep(450);
  }

  // 2. ドロップダウンやメニュー内の対象セクション名をクリック
  return withTimeout(
    page.evaluate((targetTitle) => {
      const normalize = (s) => String(s || "").replace(/\s+/g, "").trim();
      const wanted = normalize(targetTitle);

      const items = Array.from(
        document.querySelectorAll('[role="option"], [role="menuitem"], li, button, [role="button"], div, span')
      );

      for (const el of items) {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        // ボード上部の見出しそのもの（y < 180 でメニュー外）は除外
        if (r.y < 140 && !el.closest('[role="listbox"], [role="menu"], [role="dialog"], [class*="popover"], [class*="Popover"], [class*="dropdown"], [class*="Dropdown"]')) {
          continue;
        }
        const t = normalize(el.innerText);
        if (t === wanted) {
          const clickable = el.closest('[role="option"], [role="menuitem"], li, button, [role="button"]') || el;
          clickable.click();
          return true;
        }
      }
      return false;
    }, sectionTitle),
    2000,
    false
  );
}

async function clickAddButtonForSection(page, secIdx, sectionObj) {
  const sectionTitle = sectionObj && sectionObj.title ? sectionObj.title : `セクション${secIdx + 1}`;

  // まず対象セクション見出しを画面内にスクロールして最新の座標を取る
  const clickInfo = await withTimeout(
    page.evaluate((targetTitle) => {
      const normalize = (s) => String(s || "").replace(/\s+/g, "").trim();
      const wanted = normalize(targetTitle);

      const headings = Array.from(document.querySelectorAll("h1, h2, h3, h4, div, span, p"));
      let headingEl = null;
      for (const el of headings) {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0 || r.y < 0 || r.y > 500) continue;
        if (normalize(el.innerText) === wanted) {
          headingEl = el;
          break;
        }
      }

      if (headingEl) {
        headingEl.scrollIntoView({ behavior: "instant", block: "nearest", inline: "center" });
      }

      const hRect = headingEl ? headingEl.getBoundingClientRect() : null;
      const centerX = hRect ? hRect.left + hRect.width / 2 : null;

      const allBtns = Array.from(
        document.querySelectorAll('button, [role="button"], [data-testid*="add"]')
      );

      const isSectionCreate = (btn) => {
        const t = (btn.innerText || "").trim().toLowerCase();
        const a = (btn.getAttribute("aria-label") || "").toLowerCase();
        const title = (btn.getAttribute("title") || "").toLowerCase();
        const testid = (btn.getAttribute("data-testid") || "").toLowerCase();
        const combined = `${t} ${a} ${title} ${testid}`;
        return (
          combined.includes("セクションを追加") ||
          combined.includes("add section") ||
          combined.includes("new section") ||
          combined.includes("create section") ||
          combined.includes("section")
        );
      };

      const isFloatingBottomPostBtn = (btn) => {
        const r = btn.getBoundingClientRect();
        const t = (btn.innerText || "").trim();
        return r.y > window.innerHeight - 130 && (t.includes("投稿") || t === "+");
      };

      const isColumnAddBtn = (btn) => {
        if (isSectionCreate(btn) || isFloatingBottomPostBtn(btn)) return false;
        const r = btn.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const t = (btn.innerText || "").trim();
        const a = (btn.getAttribute("aria-label") || "").toLowerCase();
        const testid = (btn.getAttribute("data-testid") || "").toLowerCase();
        return (
          t === "+" ||
          t.includes("Add") ||
          t.includes("追加") ||
          a.includes("add") ||
          a.includes("追加") ||
          testid.includes("add")
        );
      };

      // 1. セクション列内の「+ / 追加」ボタン（右下フローティングボタンを除外）
      if (centerX !== null) {
        const columnBtns = allBtns
          .filter((btn) => {
            if (!isColumnAddBtn(btn)) return false;
            const r = btn.getBoundingClientRect();
            const bx = r.left + r.width / 2;
            return Math.abs(bx - centerX) < 180 && r.y > 40 && r.y < window.innerHeight - 130;
          })
          .sort((a, b) => {
            const ra = a.getBoundingClientRect();
            const rb = b.getBoundingClientRect();
            return (
              Math.abs(ra.left + ra.width / 2 - centerX) -
              Math.abs(rb.left + rb.width / 2 - centerX)
            );
          });

        if (columnBtns.length > 0) {
          const target = columnBtns[0];
          target.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
          target.click();
          return { clicked: true, viaFloating: false };
        }
      }

      // 2. 列内ボタンがない場合は右下の「+ 投稿」フローティングボタンを使う
      const floatingBtn = allBtns.find((btn) => {
        if (isSectionCreate(btn)) return false;
        const r = btn.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const t = (btn.innerText || "").trim();
        const a = (btn.getAttribute("aria-label") || "").toLowerCase();
        return t.includes("投稿") || t === "+" || a.includes("add") || a.includes("post");
      });

      if (floatingBtn) {
        floatingBtn.click();
        return { clicked: true, viaFloating: true };
      }

      return { clicked: false, viaFloating: false };
    }, sectionTitle),
    3000,
    { clicked: false, viaFloating: false }
  );

  if (!clickInfo || !clickInfo.clicked) return false;

  // 右下の「+ 投稿」から開いた場合はフォーム内のセクション選択を切り替える
  if (clickInfo.viaFloating) {
    await sleep(600);
    await selectSectionInOpenComposer(page, sectionTitle);
  }

  return true;
}

async function clickPublishAndVerify(page) {
  let clickedAny = false;

  for (let attempt = 0; attempt < 2; attempt++) {
    const clicked = await withTimeout(
      page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
        for (const b of buttons) {
          if (b.disabled || b.getAttribute("aria-disabled") === "true") continue;
          const t = (b.innerText || "").trim();
          const a = (b.getAttribute("aria-label") || "").toLowerCase();
          const testid = (b.getAttribute("data-testid") || "").toLowerCase();
          const rect = b.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            if (
              t === "公開" ||
              t === "Publish" ||
              t.includes("公開") ||
              t.includes("Publish") ||
              t.includes("送信") ||
              t.includes("投稿する") ||
              a.includes("publish") ||
              a.includes("submit") ||
              a.includes("send") ||
              testid.includes("publish") ||
              testid.includes("submit")
            ) {
              b.scrollIntoView({ behavior: "instant", block: "center" });
              b.click();
              return true;
            }
          }
        }
        return false;
      }),
      2500,
      false
    );

    if (clicked) {
      clickedAny = true;
    } else {
      await withTimeout(page.keyboard.press("Control+Enter"), 1500, null);
    }

    await sleep(1200);

    const stillOpen = await withTimeout(
      page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
        return buttons.some((b) => {
          const r = b.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return false;
          const t = (b.innerText || "").trim();
          const a = (b.getAttribute("aria-label") || "").toLowerCase();
          return (
            t === "公開" ||
            t === "Publish" ||
            t.includes("公開") ||
            t.includes("Publish") ||
            a.includes("publish")
          );
        });
      }),
      1500,
      false
    );

    if (!stillOpen) break;
  }

  return clickedAny;
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

  const jobStartTime = Date.now();
  const isTimedOut = () => Date.now() - jobStartTime > MAX_JOB_DURATION_MS;
  const shouldStop = () => Boolean(jobState.stopped) || isTimedOut();

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
  console.log(
    `[RUN START] jobId=${jobId} rounds=${totalRounds} post=${doPost} comment=${doComment} video=${doVideo}`
  );

  try {
    browser = await withTimeout(
      chromium.launch({
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--no-zygote"
        ]
      }),
      25000,
      null
    );

    if (!browser) {
      throw new Error("ブラウザの起動がタイムアウトしました。");
    }

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

    context = await withTimeout(browser.newContext(contextOptions), 15000, null);
    if (!context) {
      throw new Error("ブラウザコンテキストの作成がタイムアウトしました。");
    }

    page = await withTimeout(context.newPage(), 15000, null);
    if (!page) {
      throw new Error("ページの作成がタイムアウトしました。");
    }

    if (shouldStop()) {
      stoppedByUser = true;
    } else {
      await withTimeout(
        page.goto(parsedUrl.toString(), { waitUntil: "domcontentloaded", timeout: 45000 }),
        48000,
        null
      );
      const boardWait = await waitForPadletBoardReady(page, shouldStop, 35000);
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
          const sectionList = info.sections || [];
          const loopCount = Math.max(sectionList.length, 1);
          detectedSections = loopCount;

          for (let secIdx = 0; secIdx < loopCount; secIdx++) {
            if (shouldStop()) {
              stoppedByUser = true;
              break;
            }

            const secObj = sectionList[secIdx] || {
              title: `セクション${secIdx + 1}`,
              centerX: null
            };
            const sectionName = `Section ${secIdx + 1}`;
            try {
              await withTimeout(page.keyboard.press("Escape"), 1000, null);
              await sleep(250);

              const clickedAdd = await clickAddButtonForSection(page, secIdx, secObj);
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

              const editables = await waitForPostEditor(page, shouldStop, 6000);
              if (shouldStop()) {
                stoppedByUser = true;
                break;
              }

              if (!editables) {
                logs.push({
                  type: "post",
                  section: sectionName,
                  attempt: roundNum,
                  status: "error",
                  detail: "投稿フォームの入力欄が開きませんでした",
                  timestamp: new Date().toISOString()
                });
                await withTimeout(page.keyboard.press("Escape"), 1000, null);
                continue;
              }

              const editableCount = await withTimeout(editables.count(), 1500, 0);
              if (editableCount > 0) {
                await setEditableValueExact(editables.nth(0), titleMessage);
              }
              if (editableCount > 1) {
                await setEditableValueExact(editables.nth(1), customMessage);
              }

              if (await sleepWithStop(500, shouldStop)) {
                stoppedByUser = true;
                break;
              }

              if (imagePath && fs.existsSync(imagePath)) {
                const fileInput = page.locator('input[type="file"]').first();
                const fileCount = await withTimeout(fileInput.count(), 1500, 0);
                if (fileCount > 0) {
                  await withTimeout(fileInput.setInputFiles(imagePath), 5000, null);
                  if (await sleepWithStop(1200, shouldStop)) {
                    stoppedByUser = true;
                    break;
                  }
                }
              }

              const pubClicked = await clickPublishAndVerify(page);

              logs.push({
                type: "post",
                section: sectionName,
                attempt: roundNum,
                status: "ok",
                detail: pubClicked
                  ? `${secObj.title} へ公開ボタンで送信しました`
                  : `${secObj.title} へショートカットで送信しました`,
                timestamp: new Date().toISOString()
              });

              if (await sleepWithStop(1800, shouldStop)) {
                stoppedByUser = true;
                break;
              }
            } catch (err) {
              await withTimeout(page.keyboard.press("Escape"), 1000, null);
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

            try {
              const opened = await withTimeout(
                page.evaluate(() => {
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
                }),
                2000,
                false
              );

              if (!opened) break;

              if (await sleepWithStop(800, shouldStop)) {
                stoppedByUser = true;
                break;
              }

              const editor = await findCommentEditorLocator(page, 4000);
              if (!editor) {
                await withTimeout(page.keyboard.press("Escape"), 1000, null);
                continue;
              }

              for (let r = 1; r <= cRepeat; r++) {
                if (shouldStop()) {
                  stoppedByUser = true;
                  break;
                }

                await setEditableValueExact(editor, commentMessage);
                if (await sleepWithStop(500, shouldStop)) {
                  stoppedByUser = true;
                  break;
                }

                const sentByButton = await withTimeout(
                  page.evaluate(() => {
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
                  }),
                  2000,
                  false
                );

                if (!sentByButton) {
                  await withTimeout(page.keyboard.press("Enter"), 1500, null);
                }

                logs.push({
                  type: "comment",
                  section: `round-${roundNum}/post-${i + 1}`,
                  attempt: r,
                  status: "ok",
                  detail: `コメント送信 (${r}/${cRepeat})`,
                  timestamp: new Date().toISOString()
                });

                if (await sleepWithStop(1000, shouldStop)) {
                  stoppedByUser = true;
                  break;
                }
              }

              if (stoppedByUser) break;
            } catch (commentErr) {
              await withTimeout(page.keyboard.press("Escape"), 1000, null);
              logs.push({
                type: "comment",
                section: `round-${roundNum}/post-${i + 1}`,
                attempt: 1,
                status: "error",
                detail:
                  commentErr && commentErr.message
                    ? commentErr.message.split("\n")[0]
                    : "コメントエラー",
                timestamp: new Date().toISOString()
              });
              break;
            }
          }
        }

        if (stoppedByUser) break;

        if (roundNum < totalRounds) {
          await withTimeout(
            page.reload({ waitUntil: "domcontentloaded", timeout: 45000 }),
            48000,
            null
          );
          const reloadWait = await waitForPadletBoardReady(page, shouldStop, 35000);
          stoppedByUser = reloadWait.stopped;
          if (stoppedByUser) break;
        }
      }
    }

    const videoObj = doVideo && page ? page.video() : null;
    if (context) {
      await withTimeout(context.close(), 5000, null);
      context = null;
      page = null;
    }

    let videoBase64 = null;
    let videoFileName = null;
    if (videoObj) {
      const savedPath = await withTimeout(videoObj.path(), 4000, null);
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
      await withTimeout(browser.close(), 4000, null);
      browser = null;
    }

    const successCount = logs.filter((l) => l.status === "ok").length;
    console.log(
      `[RUN DONE] jobId=${jobId} stopped=${stoppedByUser} timedOut=${isTimedOut()} steps=${logs.length}`
    );

    return res.json({
      ok: true,
      jobId,
      stopped: jobState.stopped,
      timedOut: isTimedOut(),
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
      stopped: jobState.stopped,
      error: err && err.message ? err.message : "Playwright実行中にエラーが発生しました。",
      logs
    });
  } finally {
    activeJobs.delete(jobId);
    if (context) {
      await withTimeout(context.close(), 2500, null);
    }
    if (browser) {
      await withTimeout(browser.close(), 2500, null);
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
