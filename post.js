const fs = require("fs");
const path = require("path");
const { sleep, setEditableValue } = require("./utils");

function resolveLocalGifPath() {
  const candidates = [
    path.join(__dirname, "_______ (3).gif"),
    path.join(__dirname, "_______.gif"),
    path.join(__dirname, "image.gif")
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  return null;
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
      return (
        r.width > 0 &&
        r.height > 0 &&
        (t === "キャンセル" || t.includes("キャンセル") || t.toLowerCase().includes("cancel"))
      );
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
    const addBtns = Array.from(
      document.querySelectorAll('button, [role="button"], [data-testid*="add"]')
    );
    let count = 0;
    for (const btn of addBtns) {
      const rect = btn.getBoundingClientRect();
      const text = (btn.innerText || "").trim();
      const aria = (btn.getAttribute("aria-label") || "").toLowerCase();
      const cls = typeof btn.className === "string" ? btn.className.toLowerCase() : "";
      if (
        (text === "+" ||
          aria.includes("add") ||
          aria.includes("追加") ||
          cls.includes("add")) &&
        rect.y > 0 &&
        rect.y < 460 &&
        rect.width > 0 &&
        rect.height > 0
      ) {
        count++;
      }
    }
    return count;
  });
}

async function clickSectionAddButton(page, targetIdx) {
  return page.evaluate((idx) => {
    const addBtns = Array.from(
      document.querySelectorAll('button, [role="button"], [data-testid*="add"]')
    );
    let count = 0;
    for (const btn of addBtns) {
      const rect = btn.getBoundingClientRect();
      const text = (btn.innerText || "").trim();
      const aria = (btn.getAttribute("aria-label") || "").toLowerCase();
      const cls = typeof btn.className === "string" ? btn.className.toLowerCase() : "";
      if (
        (text === "+" ||
          aria.includes("add") ||
          aria.includes("追加") ||
          cls.includes("add")) &&
        rect.y > 0 &&
        rect.y < 460 &&
        rect.width > 0 &&
        rect.height > 0
      ) {
        if (count === idx) {
          btn.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
          btn.click();
          return true;
        }
        count++;
      }
    }
    return false;
  }, targetIdx);
}

async function attachLocalGif(page, gifPath) {
  if (!gifPath || !fs.existsSync(gifPath)) return;

  try {
    const fileInput = page.locator('input[type="file"]').last();
    if ((await fileInput.count()) > 0) {
      await fileInput.setInputFiles(gifPath, { timeout: 7000 });
      await sleep(2400);
      await dismissUploadErrorDialog(page);
    }
  } catch (_) {
    await dismissUploadErrorDialog(page).catch(() => {});
  }
}

async function clickPublishButton(page) {
  await dismissUploadErrorDialog(page);

  const pubClicked = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
    const candidates = [];

    for (const b of buttons) {
      if (b.disabled || b.getAttribute("aria-disabled") === "true") continue;
      const rect = b.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;

      const t = (b.innerText || "").trim();
      const a = (b.getAttribute("aria-label") || "").toLowerCase();
      const testid = (b.getAttribute("data-testid") || "").toLowerCase();

      const isPublishLabel =
        t === "公開" ||
        t === "Publish" ||
        t === "送信" ||
        t === "Post" ||
        t.includes("公開") ||
        t.includes("Publish") ||
        a.includes("publish") ||
        a.includes("submit post") ||
        testid.includes("publish");

      if (isPublishLabel) {
        candidates.push({ el: b, score: rect.y + (rect.x > window.innerWidth / 2 ? 0 : 1000) });
      }
    }

    candidates.sort((a, b) => a.score - b.score);
    if (candidates.length > 0) {
      candidates[0].el.click();
      return true;
    }
    return false;
  });

  if (!pubClicked) {
    await page.keyboard.press("Control+Enter").catch(() => {});
  }

  await sleep(2200);
  await dismissUploadErrorDialog(page);
}

async function createSinglePost(page, { sectionIndex, totalSections, titleMessage, customMessage, gifPath }) {
  await dismissUploadErrorDialog(page);

  let clickedAdd = false;
  if (totalSections > 0) {
    clickedAdd = await clickSectionAddButton(page, sectionIndex);
  }

  if (!clickedAdd) {
    throw new Error("投稿追加ボタンが見つかりませんでした");
  }

  await sleep(1400);

  const editables = page.locator(
    'div[contenteditable="true"]:visible, textarea:visible, input[type="text"]:visible'
  );
  const editableCount = await editables.count();
  if (editableCount === 0) {
    throw new Error("投稿入力欄が見つかりませんでした");
  }

  await setEditableValue(editables.nth(0), titleMessage);
  if (editableCount > 1) {
    await setEditableValue(editables.nth(1), customMessage);
  }

  await sleep(600);

  if (gifPath) {
    await attachLocalGif(page, gifPath);
  }

  await clickPublishButton(page);
}

async function runPosts(page, { message, repeat }) {
  const logs = [];
  const detectedSections = await detectSections(page);
  const loopSections = Math.max(detectedSections, 1);
  const gifPath = resolveLocalGifPath();
  const textVal = message || "test";

  for (let secIdx = 0; secIdx < loopSections; secIdx++) {
    const sectionName = `Section ${secIdx + 1}`;
    for (let i = 1; i <= repeat; i++) {
      try {
        await createSinglePost(page, {
          sectionIndex: secIdx,
          totalSections: detectedSections,
          titleMessage: textVal,
          customMessage: textVal,
          gifPath
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
      await sleep(800);
    }
  }

  return {
    detectedSections: loopSections,
    logs
  };
}

module.exports = {
  runPosts
};
