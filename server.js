const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");

const app = express();
const PORT = process.env.PORT || 3000;

// プリフライト (OPTIONS) を含め、すべてのオリジンとヘッダーを許可
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

  // 1) JSON配列形式の場合
  try {
    const parsed = typeof rawCookie === "string" ? JSON.parse(rawCookie) : rawCookie;
    if (Array.isArray(parsed)) {
      return parsed
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
  } catch (_) {
    // JSONでなければ "key=value; key2=value2" 形式として処理する
  }

  // 2) "name=value; name2=value2" 文字列形式の場合
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

async function createPadletPost(page, { sectionIndex, totalSections, message, gifUrl }) {
  // 1. 投稿作成ボタンをクリック（セクション指定優先 → 全体ボタン）
  let clickedCreate = false;

  if (totalSections > 1) {
    const sections = page.locator('[data-testid*="section"], section[aria-label], [class*="section"]');
    const currentCount = await sections.count();
    if (sectionIndex < currentCount) {
      const targetSection = sections.nth(sectionIndex);
      const secBtn = targetSection
        .locator(
          'button[aria-label*="Add post" i], button[aria-label*="投稿" i], button[data-testid*="add-post" i], button:has-text("+")'
        )
        .first();
      if (await secBtn.count()) {
        await secBtn.scrollIntoViewIfNeeded();
        await secBtn.click({ timeout: 5000 });
        clickedCreate = true;
      }
    }
  }

  if (!clickedCreate) {
    const globalBtn = page
      .locator(
        'button[aria-label*="Create post" i], button[aria-label*="Add post" i], button[aria-label*="投稿を作成" i], button[data-testid*="create-post" i], [data-testid="fab-create-post"]'
      )
      .first();
    await globalBtn.waitFor({ state: "visible", timeout: 8000 });
    await globalBtn.click();
  }

  await sleep(600);

  // 2. 本文メッセージを入力
  if (message) {
    const bodyInput = page
      .locator(
        '[contenteditable="true"][data-placeholder*="write" i], [contenteditable="true"][aria-label*="body" i], [contenteditable="true"][aria-label*="write" i], textarea[placeholder*="write" i], textarea[aria-label*="body" i], [role="dialog"] [contenteditable="true"]'
      )
      .last();

    await bodyInput.waitFor({ state: "visible", timeout: 8000 });
    await bodyInput.click();
    await page.keyboard.type(message, { delay: 15 });
    await sleep(300);
  }

  // 3. GIF / リンクURLを添付
  if (gifUrl) {
    const attachBtn = page
      .locator(
        'button[aria-label*="GIF" i], button[aria-label*="Link" i], button[aria-label*="URL" i], button[aria-label*="リンク" i], button[data-testid*="link" i], button[data-testid*="gif" i]'
      )
      .first();

    if (await attachBtn.count()) {
      await attachBtn.click();
      await sleep(400);

      const urlInput = page
        .locator(
          'input[type="url"], input[placeholder*="http" i], input[placeholder*="link" i], input[placeholder*="URL" i], input[aria-label*="URL" i], input[aria-label*="link" i]'
        )
        .last();

      if (await urlInput.count()) {
        await urlInput.fill(gifUrl);
        await page.keyboard.press("Enter");
        await sleep(1200);
      }
    }
  }

  // 4. 投稿送信ボタンをクリック
  const submitBtn = page
    .locator(
      'button:has-text("Publish"), button:has-text("Post"), button:has-text("投稿"), button:has-text("公開"), button[type="submit"]'
    )
    .last();

  await submitBtn.waitFor({ state: "visible", timeout: 8000 });
  await submitBtn.click();
  await sleep(1200);
}

app.get("/", (req, res) => {
  res.json({ status: "ok", mode: "playwright-ready" });
});

app.post("/run", async (req, res) => {
  const {
    roomUrl = "",
    message = "",
    gifUrl = "",
    cookie = "",
    repeat = 2
  } = req.body || {};

  const trimmedUrl = roomUrl.trim();
  if (!trimmedUrl) {
    return res.status(400).json({ ok: false, error: "roomUrl が指定されていません。" });
  }

  const count = Math.max(1, Math.min(10, Number(repeat) || 2));
  const logs = [];
  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36"
    });

    const cookies = normalizeCookies(cookie, trimmedUrl);
    if (cookies.length > 0) {
      await context.addCookies(cookies);
    }

    const page = await context.newPage();
    await page.goto(trimmedUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await sleep(2500);

    const sectionCount = await page.locator('[data-testid*="section"], section[aria-label]').count();
    const effectiveSections = sectionCount > 0 ? sectionCount : 1;

    for (let s = 0; s < effectiveSections; s++) {
      const sectionName = `Section ${s + 1}`;
      for (let i = 1; i <= count; i++) {
        try {
          await createPadletPost(page, {
            sectionIndex: s,
            totalSections: effectiveSections,
            message,
            gifUrl
          });
          logs.push({
            section: sectionName,
            attempt: i,
            status: "ok",
            detail: "投稿完了",
            timestamp: new Date().toISOString()
          });
        } catch (stepErr) {
          logs.push({
            section: sectionName,
            attempt: i,
            status: "error",
            detail: stepErr && stepErr.message ? stepErr.message.split("\n")[0] : "投稿処理失敗",
            timestamp: new Date().toISOString()
          });
        }
        await sleep(800);
      }
    }

    await browser.close();
    const successCount = logs.filter((l) => l.status === "ok").length;

    return res.json({
      ok: true,
      detectedSections: effectiveSections,
      cookiesLoaded: cookies.length,
      totalSteps: logs.length,
      successCount,
      logs
    });
  } catch (err) {
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
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
