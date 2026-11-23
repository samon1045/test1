const fs = require("fs");
const path = require("path");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function resolveRepoGifPath(gifUrl = "") {
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

  if (gifUrl && fs.existsSync(gifUrl)) {
    return gifUrl;
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
      const aria = btn.getAttribute("aria-label") || "";
      const cls = typeof btn.className === "string" ? btn.className : "";
      if (
        (text === "+" || aria.includes("Add") || aria.includes("追加") || cls.includes("add")) &&
        rect.y > 0 &&
        rect.y < 420 &&
        rect.width > 0
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
      const aria = btn.getAttribute("aria-label") || "";
      const cls = typeof btn.className === "string" ? btn.className : "";
      if (
        (text === "+" || aria.includes("Add") || aria.includes("追加") || cls.includes("add")) &&
        rect.y > 0 &&
        rect.y < 420 &&
        rect.width > 0
      ) {
        if (count === targetIdx) {
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

async function setEditableValue(locator, text) {
  await locator.click();
  await locator.fill(text);
}

async function attachLocalGif(page, gifPath) {
  if (!gifPath || !fs.existsSync(gifPath)) return;

  try {
    const fileInput = page.locator('input[type="file"]').first();
    if ((await fileInput.count()) > 0) {
      await fileInput.setInputFiles(gifPath, { timeout: 6000 });
      await sleep(2200);
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

  await sleep(2500);
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

  await sleep(1500);

  const editables = page.locator('div[contenteditable="true"], textarea, input[type="text"]');
  const editableCount = await editables.count();
  if (editableCount === 0) {
    throw new Error("投稿入力欄が見つかりませんでした");
  }

  if (editableCount > 0) {
    await setEditableValue(editables.nth(0), titleMessage);
  }
  if (editableCount > 1) {
    await setEditableValue(editables.nth(1), customMessage);
  }

  await sleep(700);

  if (gifPath) {
    await attachLocalGif(page, gifPath);
  }

  await clickPublishButton(page);
}

async function runPosts(page, { message, gifUrl, repeat }) {
  const logs = [];
  const detectedSections = await detectSections(page);
  const loopSections = Math.max(detectedSections, 1);
  const gifPath = resolveRepoGifPath(gifUrl);
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
