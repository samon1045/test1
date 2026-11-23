const fs = require("fs");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 各セクションの「+」ボタンを座標（左→右）順に取得して数を返す
async function detectSections(page) {
  return page.evaluate(() => {
    const addButtons = Array.from(document.querySelectorAll('button, [role="button"]')).filter((el) => {
      const rect = el.getBoundingClientRect();
      const text = (el.innerText || "").trim();
      const aria = (el.getAttribute("aria-label") || "").toLowerCase();
      // 右下の「+ 投稿」FABは除外
      const isRightBottomFab = rect.x > window.innerWidth * 0.82 && rect.y > window.innerHeight * 0.78;
      if (isRightBottomFab || rect.width <= 0 || rect.height <= 0) return false;
      // セクションヘッダー直下の横長「+」ボタン（Y座標 120〜420px付近）
      if (rect.y < 100 || rect.y > 450) return false;
      return (
        text === "+" ||
        aria.includes("add post") ||
        aria.includes("投稿を追加")
      );
    });

    // 左から右へソート
    addButtons.sort((a, b) => a.getBoundingClientRect().x - b.getBoundingClientRect().x);
    return addButtons.length;
  });
}

async function clickSectionAddButton(page, targetIdx) {
  return page.evaluate((idx) => {
    const addButtons = Array.from(document.querySelectorAll('button, [role="button"]')).filter((el) => {
      const rect = el.getBoundingClientRect();
      const text = (el.innerText || "").trim();
      const aria = (el.getAttribute("aria-label") || "").toLowerCase();
      const isRightBottomFab = rect.x > window.innerWidth * 0.82 && rect.y > window.innerHeight * 0.78;
      if (isRightBottomFab || rect.width <= 0 || rect.height <= 0) return false;
      if (rect.y < 100 || rect.y > 450) return false;
      return (
        text === "+" ||
        aria.includes("add post") ||
        aria.includes("投稿を追加")
      );
    });

    addButtons.sort((a, b) => a.getBoundingClientRect().x - b.getBoundingClientRect().x);

    if (idx < addButtons.length) {
      const btn = addButtons[idx];
      btn.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
      btn.click();
      return true;
    }
    return false;
  }, targetIdx);
}

// GIFファイルをペースト（ClipboardEvent）＋ file input の両方で添付
async function attachGifToComposer(page, gifFilePath) {
  if (!gifFilePath || !fs.existsSync(gifFilePath)) return false;

  const base64Data = fs.readFileSync(gifFilePath).toString("base64");

  await page.evaluate(async (b64) => {
    const binStr = atob(b64);
    const len = binStr.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binStr.charCodeAt(i);
    }
    const file = new File([bytes], "anim.gif", { type: "image/gif" });

    if (navigator.clipboard && typeof ClipboardItem !== "undefined") {
      try {
        await navigator.clipboard.write([new ClipboardItem({ "image/gif": file })]);
      } catch (_) {}
    }

    const targets = Array.from(
      document.querySelectorAll('[contenteditable="true"], textarea, input[type="text"], [role="dialog"]')
    ).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.x > window.innerWidth * 0.35;
    });

    const target = targets[targets.length - 1] || document.activeElement || document.body;
    target.focus();

    const dt = new DataTransfer();
    dt.items.add(file);

    const pasteEvent = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: dt
    });
    target.dispatchEvent(pasteEvent);
  }, base64Data);

  await sleep(600);
  await page.keyboard.down("Control");
  await page.keyboard.press("v");
  await page.keyboard.up("Control");
  await sleep(1200);

  // hidden の input[type="file"] にも直接セットして確実にアップロードさせる
  const fileInputs = page.locator('input[type="file"]');
  const fileInputCount = await fileInputs.count();
  if (fileInputCount > 0) {
    try {
      await fileInputs.last().setInputFiles(gifFilePath);
      await sleep(2200);
    } catch (_) {}
  }

  return true;
}

async function clickPublishAndEnsureClosed(page) {
  const clicked = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('button, [role="button"]')).filter((el) => {
      const rect = el.getBoundingClientRect();
      const text = (el.innerText || "").trim();
      const aria = (el.getAttribute("aria-label") || "").toLowerCase();
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        (text === "公開" ||
          text.includes("公開") ||
          text.includes("Publish") ||
          aria.includes("publish"))
      );
    });

    if (candidates.length === 0) return false;
    candidates.sort((a, b) => b.getBoundingClientRect().x - a.getBoundingClientRect().x);
    candidates[0].click();
    return true;
  });

  if (!clicked) {
    await page.keyboard.press("Control+Enter");
  }

  // 投稿送信＆カードが閉じるまで少し待つ
  await sleep(2500);

  // 万が一カードが残っていたら「×」で閉じる
  await page.evaluate(() => {
    const closeBtns = Array.from(document.querySelectorAll('button, [role="button"]')).filter((el) => {
      const r = el.getBoundingClientRect();
      const t = (el.innerText || "").trim();
      const a = (el.getAttribute("aria-label") || "").toLowerCase();
      return (
        r.width > 0 &&
        r.height > 0 &&
        r.x > window.innerWidth * 0.5 &&
        r.y < window.innerHeight * 0.45 &&
        (t === "×" || t === "✕" || a.includes("close") || a.includes("閉じる"))
      );
    });
    if (closeBtns.length > 0) {
      closeBtns[0].click();
    }
  });

  await sleep(700);
}

async function createSinglePost(page, { sectionIndex, totalSections, message, gifFilePath }) {
  let clickedAdd = false;
  if (totalSections > 0) {
    clickedAdd = await clickSectionAddButton(page, sectionIndex);
  }

  if (!clickedAdd) {
    // フォールバック：右下の「+ 投稿」ボタン
    clickedAdd = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
      for (const b of btns) {
        const rect = b.getBoundingClientRect();
        const t = (b.innerText || "").trim();
        const a = (b.getAttribute("aria-label") || "").toLowerCase();
        if (
          rect.width > 0 &&
          rect.height > 0 &&
          (t.includes("投稿") || t === "+" || a.includes("create post") || a.includes("add post"))
        ) {
          b.click();
          return true;
        }
      }
      return false;
    });
  }

  if (!clickedAdd) {
    throw new Error("投稿追加ボタンが見つかりませんでした");
  }

  await sleep(1400);

  // 開いた投稿カード内の入力欄を取得
  const editables = page.locator('div[contenteditable="true"], textarea, input[type="text"]');
  const editableCount = await editables.count();
  if (editableCount === 0) {
    throw new Error("投稿入力欄が見つかりませんでした");
  }

  const textToType = message || "test";
  if (editableCount === 1) {
    const target = editables.first();
    await target.click();
    await target.fill(textToType);
  } else {
    // 1つ目（件名）と最後の入力欄（本文）に入力
    await editables.nth(0).click();
    await editables.nth(0).fill(textToType);
    await sleep(250);
    await editables.nth(editableCount - 1).click();
    await editables.nth(editableCount - 1).fill(textToType);
  }

  await sleep(500);

  if (gifFilePath && fs.existsSync(gifFilePath)) {
    await attachGifToComposer(page, gifFilePath);
  }

  await clickPublishAndEnsureClosed(page);
}

async function runPosts(page, { message, gifFilePath, repeat }) {
  const logs = [];
  const detectedSections = await detectSections(page);
  const effectiveSections = detectedSections > 0 ? detectedSections : 1;

  for (let s = 0; s < effectiveSections; s++) {
    const sectionName = `Section ${s + 1}`;
    for (let i = 1; i <= repeat; i++) {
      try {
        await createSinglePost(page, {
          sectionIndex: s,
          totalSections: detectedSections,
          message,
          gifFilePath
        });
        logs.push({
          type: "post",
          section: sectionName,
          attempt: i,
          status: "ok",
          detail: "投稿完了",
          timestamp: new Date().toISOString()
        });
      } catch (err) {
        logs.push({
          type: "post",
          section: sectionName,
          attempt: i,
          status: "error",
          detail: err && err.message ? err.message.split("\n")[0] : "投稿処理失敗",
          timestamp: new Date().toISOString()
        });
      }
      await sleep(800);
    }
  }

  return {
    detectedSections: effectiveSections,
    logs
  };
}

module.exports = {
  runPosts
};
