const fs = require("fs");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function detectSections(page) {
  return page.evaluate(() => {
    // 「セクション1」「セクション2」などの見出しや各セクション直下の「+」ボタンを数える
    const allEls = Array.from(document.querySelectorAll('button, [role="button"], h2, h3, div, span'));
    const addButtons = Array.from(document.querySelectorAll('button, [role="button"]')).filter((el) => {
      const rect = el.getBoundingClientRect();
      const text = (el.innerText || "").trim();
      const aria = (el.getAttribute("aria-label") || "").toLowerCase();
      // 右下の「+ 投稿」やヘッダー上のボタンを除外し、セクション列の「+」に絞る
      const isRightBottomFab = rect.x > window.innerWidth * 0.8 && rect.y > window.innerHeight * 0.8;
      if (isRightBottomFab || rect.width <= 0 || rect.height <= 0) return false;
      if (rect.y < 120 || rect.y > 550) return false;
      return (
        text === "+" ||
        aria.includes("add post") ||
        aria.includes("投稿を追加") ||
        aria.includes("セクション")
      );
    });

    if (addButtons.length > 0) {
      return addButtons.length;
    }

    const sectionHeaders = allEls.filter((el) => {
      const t = (el.innerText || "").trim();
      const rect = el.getBoundingClientRect();
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.y > 100 &&
        rect.y < 400 &&
        /^セクション\s*\d+$|^Section\s*\d+$/i.test(t) &&
        el.children.length === 0
      );
    });

    return sectionHeaders.length;
  });
}

async function clickSectionAddButton(page, targetIdx) {
  return page.evaluate((idx) => {
    const addButtons = Array.from(document.querySelectorAll('button, [role="button"]')).filter((el) => {
      const rect = el.getBoundingClientRect();
      const text = (el.innerText || "").trim();
      const aria = (el.getAttribute("aria-label") || "").toLowerCase();
      const isRightBottomFab = rect.x > window.innerWidth * 0.8 && rect.y > window.innerHeight * 0.8;
      if (isRightBottomFab || rect.width <= 0 || rect.height <= 0) return false;
      if (rect.y < 120 || rect.y > 550) return false;
      return (
        text === "+" ||
        aria.includes("add post") ||
        aria.includes("投稿を追加") ||
        aria.includes("セクション")
      );
    });

    if (idx < addButtons.length) {
      addButtons[idx].scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
      addButtons[idx].click();
      return true;
    }
    return false;
  }, targetIdx);
}

// GIFファイルをブラウザ上でコピー＆ペースト（ClipboardEvent + DataTransfer）する
async function pasteGifToComposer(page, gifFilePath) {
  if (!gifFilePath || !fs.existsSync(gifFilePath)) return false;

  const base64Data = fs.readFileSync(gifFilePath).toString("base64");

  const pasted = await page.evaluate(async (b64) => {
    const binStr = atob(b64);
    const len = binStr.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binStr.charCodeAt(i);
    }
    const file = new File([bytes], "anim.gif", { type: "image/gif" });

    // 可能な場合は ClipboardItem にも書き込む（Ctrl+V / 貼り付けイベントの両対応用）
    if (navigator.clipboard && typeof ClipboardItem !== "undefined") {
      try {
        await navigator.clipboard.write([new ClipboardItem({ "image/gif": file })]);
      } catch (_) {}
    }

    // 投稿カード内のフォーカス先を探す
    const targets = Array.from(
      document.querySelectorAll(
        '[contenteditable="true"], textarea, input[type="text"], [role="dialog"]'
      )
    ).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.x > window.innerWidth * 0.4;
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

    return target.dispatchEvent(pasteEvent);
  }, base64Data);

  await sleep(800);

  // 念のため実際の Ctrl+V / Meta+V キー操作も送る
  await page.keyboard.down("Control");
  await page.keyboard.press("v");
  await page.keyboard.up("Control");
  await sleep(1500);

  // もし貼り付けで反映されなかった場合のフォールバック（file input への直接セット）
  const fileInputCount = await page.locator('input[type="file"]').count();
  if (!pasted && fileInputCount > 0) {
    await page.locator('input[type="file"]').first().setInputFiles(gifFilePath);
    await sleep(2000);
  }

  return true;
}

async function clickPublishButton(page) {
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
    // 一番右・手前にある公開ボタンをクリック
    candidates.sort((a, b) => b.getBoundingClientRect().x - a.getBoundingClientRect().x);
    candidates[0].click();
    return true;
  });

  if (!clicked) {
    await page.keyboard.press("Control+Enter");
  }

  await sleep(2000);

  // 下書きカードが残っていたら「×」で閉じて次のループを詰まらせない
  await page.evaluate(() => {
    const closeBtns = Array.from(document.querySelectorAll('button, [role="button"]')).filter((el) => {
      const r = el.getBoundingClientRect();
      const t = (el.innerText || "").trim();
      const a = (el.getAttribute("aria-label") || "").toLowerCase();
      return (
        r.width > 0 &&
        r.height > 0 &&
        r.x > window.innerWidth * 0.5 &&
        (t === "×" || t === "✕" || a.includes("close") || a.includes("閉じる"))
      );
    });
    if (closeBtns.length > 0) {
      closeBtns[0].click();
    }
  });

  await sleep(800);
}

async function createSinglePost(page, { sectionIndex, totalSections, message, gifFilePath }) {
  let clickedAdd = false;
  if (totalSections > 0) {
    clickedAdd = await clickSectionAddButton(page, sectionIndex);
  }

  if (!clickedAdd) {
    clickedAdd = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
      for (const b of btns) {
        const rect = b.getBoundingClientRect();
        const t = (b.innerText || "").trim();
        const a = (b.getAttribute("aria-label") || "").toLowerCase();
        if (
          rect.width > 0 &&
          rect.height > 0 &&
          (t === "+" ||
            a.includes("add") ||
            a.includes("create") ||
            a.includes("追加") ||
            a.includes("投稿"))
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

  await sleep(1200);

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
    await editables.nth(0).click();
    await editables.nth(0).fill(textToType);
    await sleep(200);
    await editables.nth(editableCount - 1).click();
    await editables.nth(editableCount - 1).fill(textToType);
  }

  await sleep(500);

  if (gifFilePath && fs.existsSync(gifFilePath)) {
    await pasteGifToComposer(page, gifFilePath);
  }

  await clickPublishButton(page);
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
      await sleep(700);
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
