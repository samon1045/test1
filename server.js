const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeCookies(rawCookie) {
  if (!rawCookie) return [];
  try {
    const parsed = typeof rawCookie === "string" ? JSON.parse(rawCookie) : rawCookie;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((c) => c && c.name && c.value !== undefined)
      .map((c) => {
        const cookieObj = {
          name: String(c.name),
          value: String(c.value),
          domain: c.domain || ".padlet.com",
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
        }
        return cookieObj;
      });
  } catch (_) {
    return [];
  }
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

  if (!roomUrl.trim()) {
    return res.status(400).json({ ok: false, error: "roomUrl が指定されていません。" });
  }

  const count = Math.max(1, Math.min(10, Number(repeat) || 2));
  const logs = [];
  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const context = await browser.newContext();
    const cookies = normalizeCookies(cookie);
    if (cookies.length > 0) {
      await context.addCookies(cookies);
    }

    const page = await context.newPage();
    await page.goto(roomUrl.trim(), { waitUntil: "domcontentloaded", timeout: 45000 });
    await sleep(2500);

    // 実際のPadlet画面のセクション要素に合わせてセレクタを調整する
    const sectionCount = await page.locator('[data-testid*="section"], section').count();
    const effectiveSections = sectionCount > 0 ? sectionCount : 1;

    for (let s = 0; s < effectiveSections; s++) {
      const sectionName = `Section ${s + 1}`;
      for (let i = 1; i <= count; i++) {
        // ここに「投稿作成ボタンクリック → メッセージ入力 → GIF添付 → 送信」のPlaywright操作を追加
        await sleep(500);
        logs.push({
          section: sectionName,
          attempt: i,
          message,
          gifUrl,
          timestamp: new Date().toISOString()
        });
      }
    }

    await browser.close();
    return res.json({
      ok: true,
      detectedSections: effectiveSections,
      cookiesLoaded: cookies.length,
      totalSteps: logs.length,
      logs
    });
  } catch (err) {
    if (browser) {
      try { await browser.close(); } catch (_) {}
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
