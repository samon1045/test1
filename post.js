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

async function dismissAnyDialog(page) {
  const closed = await page.evaluate(() => {
    const bodyText = document.body ? document.body.innerText || "" : "";
    const hasError =
      bodyText.includes("添付ファイルの読み込み中にエラーが発生しました") ||
      bodyText.includes("ファイルのアップロード中にエラーが発生しました") ||
      bodyText.includes("写真をアップロードできませんでした");

    const btns = Array.from(document.querySelectorAll('button, [role="button"]'));

    if (hasError) {
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
    }

    return false;
  });

  if (closed) {
    await sleep(600);
  }
  return closed;
}

async function closeStrayPickers(page) {
  // 絵文字ピッカーや検索モーダルが開いていたら閉じる
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(250);
  await dismissAnyDialog(page);
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
        rect.y < 380 &&
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
        rect.y < 380 &&
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

async function attachGifSafely(page, gifPath) {
  if (!gifPath || !fs.existsSync(gifPath)) return;

  try {
    const fileInput = page.locator('input[type="file"]').first();
    if ((await fileInput.count()) > 0) {
      await fileInput.setInputFiles(gifPath, { timeout: 6000 });
      await sleep(1800);
      await dismissAnyDialog(page);
    }
  } catch (_) {
    await dismissAnyDialog(page).catch(() => {});
  }
}

async function clickPublishButton(page) {
  await dismissAnyDialog(page);

  const pubClicked = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
    for (const b of buttons) {
      if (b.disabled || b.getAttribute("aria-disabled") === "true") continue;
      const t = (b.innerText || "").trim();
      const a = (b.getAttribute("aria-label") || "").toLowerCase();
      const testid = (b.getAttribute("data-testid") || "").toLowerCase();
      const cls = typeof b.className === "string" ? b.className.toLowerCase() : "";
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

  await sleep(2200);
  await dismissAnyDialog(page);
}

async function createSinglePost(page, { sectionIndex, totalSections, titleMessage, customMessage, gifPath }) {
  await closeStrayPickers(page);

  let clickedAdd = false;
  if (totalSections > 0) {
    clickedAdd = await clickSectionAddButton(page, sectionIndex);
  } else {
    clickedAdd = await clickSectionAddButton(page, 0);
  }

  if (!clickedAdd) {
    throw new Error("投稿追加ボタンが見つかりませんでした");
  }

  await sleep(1500);

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

  await sleep(700);
  await attachGifSafely(page, gifPath);
  await clickPublishButton(page);
}

async function runPosts(page, { message, repeat }) {
  const logs = [];
  const detectedSections = await detectSections(page);
  const loopSections = Math.max(detectedSections, 1);
  const gifPath = resolveLocalGifPath();
  const textVal = message || "test";

  for (let i = 1; i <= repeat; i++) {
    for (let secIdx = 0; secIdx < loopSections; secIdx++) {
      const sectionName = `Section ${secIdx + 1}`;
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
        await closeStrayPickers(page).catch(() => {});
        logs.push({
          type: "post",
          section: sectionName,
          attempt: i,
          status: "error",
          detail: err && err.message ? err.message.split("\n")[0] : "投稿処理失敗",
          timestamp: new Date().toISOString()
        });
      }
      await sleep(900);
    }

    // 次の周回へ行く前に一度リロードして画面状態をリセット（参考コードのラウンド方式）
    if (i < repeat) {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
      await sleep(3500);
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
