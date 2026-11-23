const fs = require("fs");
const path = require("path");
const { sleep, setEditableValue } = require("./utils");

function resolveLocalGifPath() {
  const candidates = [
    path.join(__dirname, "_______.gif"),
    path.join(__dirname, "_______ (3).gif"),
    path.join(__dirname, "image.gif")
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  return null;
}

async function dismissAnyDialog(page) {
  const closed = await page.evaluate(() => {
    const bodyText = document.body ? document.body.innerText || "" : "";
    const hasError =
      bodyText.includes("添付ファイルの読み込み中にエラーが発生しました") ||
      bodyText.includes("ファイルのアップロード中にエラーが発生しました") ||
      bodyText.includes("写真をアップロードできませんでした");

    if (!hasError) return false;

    const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
    const okOrCancel = btns.find((b) => {
      const r = b.getBoundingClientRect();
      const t = (b.innerText || "").trim();
      return (
        r.width > 0 &&
        r.height > 0 &&
        (t === "OK" ||
          t === "キャンセル" ||
          t.includes("キャンセル") ||
          t.toLowerCase() === "ok" ||
          t.toLowerCase().includes("cancel"))
      );
    });

    if (okOrCancel) {
      okOrCancel.click();
      return true;
    }
    return false;
  });

  if (closed) {
    await sleep(600);
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
        rect.y < 350 &&
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
        rect.y < 350 &&
        rect.width > 0
      ) {
        if (count === idx) {
          btn.click();
          return true;
        }
        count++;
      }
    }
    return false;
  }, targetIdx);
}

async function createSinglePost(page, { secIdx, titleMessage, customMessage, imagePath }) {
  const clickedAdd = await clickSectionAddButton(page, secIdx);
  if (!clickedAdd) {
    throw new Error(`セクション ${secIdx + 1} の追加ボタンが見つかりませんでした`);
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

  await sleep(800);

  if (imagePath && fs.existsSync(imagePath)) {
    try {
      const fileInput = page.locator('input[type="file"]').first();
      if ((await fileInput.count()) > 0) {
        await fileInput.setInputFiles(imagePath);
        await sleep(2000);
        await dismissAnyDialog(page);
      }
    } catch (_) {
      await dismissAnyDialog(page).catch(() => {});
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
    await page.keyboard.press("Control+Enter").catch(() => {});
  }

  await sleep(3500);
  await dismissAnyDialog(page);
}

async function runPosts(page, { message, repeat = 2 }) {
  const logs = [];
  const totalRounds = Math.max(Number(repeat) || 1, 1);
  const titleMessage = message || "お知らせ";
  const customMessage = message || "メッセージ";
  const imagePath = resolveLocalGifPath();
  let lastDetectedSections = 1;

  for (let roundNum = 1; roundNum <= totalRounds; roundNum++) {
    const totalSections = await detectSections(page);
    const loopCount = Math.max(totalSections, 1);
    lastDetectedSections = loopCount;

    for (let secIdx = 0; secIdx < loopCount; secIdx++) {
      const sectionName = `Section ${secIdx + 1}`;
      try {
        await createSinglePost(page, {
          secIdx,
          titleMessage,
          customMessage,
          imagePath
        });
        logs.push({
          type: "post",
          section: sectionName,
          attempt: roundNum,
          status: "ok",
          detail: "投稿送信完了",
          timestamp: new Date().toISOString()
        });
      } catch (err) {
        await page.keyboard.press("Escape").catch(() => {});
        await dismissAnyDialog(page).catch(() => {});
        logs.push({
          type: "post",
          section: sectionName,
          attempt: roundNum,
          status: "error",
          detail: err && err.message ? err.message.split("\n")[0] : "投稿処理失敗",
          timestamp: new Date().toISOString()
        });
      }
    }

    if (roundNum < totalRounds) {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
      await sleep(5000);
    }
  }

  return {
    detectedSections: lastDetectedSections,
    logs
  };
}

module.exports = {
  runPosts
};
