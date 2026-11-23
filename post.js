const fs = require("fs");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isLikelyImageFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return false;
  try {
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(12);
    const bytesRead = fs.readSync(fd, buf, 0, 12, 0);
    fs.closeSync(fd);
    if (bytesRead < 4) return false;

    const headerStr = buf.toString("ascii", 0, 6);
    // GIF87a / GIF89a
    if (headerStr === "GIF87a" || headerStr === "GIF89a") return true;
    // PNG: 89 50 4E 47
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
    // JPEG: FF D8 FF
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
    // WEBP: RIFF....WEBP
    if (
      buf.toString("ascii", 0, 4) === "RIFF" &&
      bytesRead >= 12 &&
      buf.toString("ascii", 8, 12) === "WEBP"
    ) {
      return true;
    }
    return false;
  } catch (_) {
    return false;
  }
}

async function dismissUploadErrorDialog(page) {
  const closed = await page.evaluate(() => {
    const bodyText = document.body ? document.body.innerText || "" : "";
    const hasError =
      bodyText.includes("添付ファイルの読み込み中にエラーが発生しました") ||
      bodyText.includes("ファイルのアップロード中にエラーが発生しました") ||
      bodyText.includes("写真をアップロードできませんでした");

    if (!hasError) return false;

    const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
    const cancelBtn = btns.find((b) => {
      const r = b.getBoundingClientRect();
      const t = (b.innerText || "").trim();
      return r.width > 0 && r.height > 0 && (t === "キャンセル" || t.includes("キャンセル") || t.toLowerCase().includes("cancel"));
    });

    if (cancelBtn) {
      cancelBtn.click();
      return true;
    }
    return false;
  });

  if (closed) {
    await sleep(700);
  }
  return closed;
}

async function detectSections(page) {
  return page.evaluate(() => {
    const addButtons = Array.from(document.querySelectorAll('button, [role="button"]')).filter((el) => {
      const rect = el.getBoundingClientRect();
      const text = (el.innerText || "").trim();
      const aria = (el.getAttribute("aria-label") || "").toLowerCase();
      const isRightBottomFab = rect.x > window.innerWidth * 0.82 && rect.y > window.innerHeight * 0.78;
      if (isRightBottomFab || rect.width <= 0 || rect.height <= 0) return false;
      if (rect.y < 100 || rect.y > 480) return false;
      return (
        text === "+" ||
        aria.includes("add post") ||
        aria.includes("投稿を追加")
      );
    });

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
      if (rect.y < 100 || rect.y > 480) return false;
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

async function waitForPostInputs(page, timeoutMs = 5000) {
  const start = Date.now();
  const locator = page.locator('div[contenteditable="true"], textarea, input[type="text"], [role="textbox"]');
  while (Date.now() - start < timeoutMs) {
    const count = await locator.count();
    if (count > 0) {
      return locator;
    }
    await sleep(250);
  }
  return null;
}

async function attachGifToComposer(page, gifFilePath) {
  if (!isLikelyImageFile(gifFilePath)) {
    return false;
  }

  let uploaded = false;
  const fileInputs = page.locator('input[type="file"]');
  if ((await fileInputs.count()) > 0) {
    try {
      await fileInputs.last().setInputFiles(gifFilePath, { timeout: 5000 });
      uploaded = true;
    } catch (_) {}
  }

  // アップロード完了またはエラーダイアログ出現を最大6秒監視
  const start = Date.now();
  while (Date.now() - start < 6000) {
    const hadError = await dismissUploadErrorDialog(page);
    if (hadError) {
      return false;
    }
    const stillUploading = await page.evaluate(() => {
      const txt = document.body ? document.body.innerText || "" : "";
      return txt.includes("アップロードしています");
    });
    if (uploaded && !stillUploading && Date.now() - start > 1500) {
      break;
    }
    await sleep(400);
  }

  await dismissUploadErrorDialog(page);
  return uploaded;
}

async function clickPublishAndEnsureClosed(page) {
  await dismissUploadErrorDialog(page);

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

  await sleep(2200);
  await dismissUploadErrorDialog(page);

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

  await sleep(600);
}

async function createSinglePost(page, { sectionIndex, totalSections, message, gifFilePath }) {
  await dismissUploadErrorDialog(page);

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

  let editables = await waitForPostInputs(page, 5000);

  if (!editables && totalSections > 0) {
    await clickSectionAddButton(page, sectionIndex);
    editables = await waitForPostInputs(page, 3500);
  }

  if (!editables) {
    throw new Error("投稿入力欄が見つかりませんでした");
  }

  const editableCount = await editables.count();
  const textToType = message || "test";
  if (editableCount === 1) {
    const target = editables.first();
    await target.click();
    await target.fill(textToType);
  } else {
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
        await dismissUploadErrorDialog(page).catch(() => {});
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
