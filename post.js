const fs = require("fs");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
        (text === "+" ||
          aria.includes("Add") ||
          aria.includes("追加") ||
          cls.includes("add")) &&
        rect.y > 0 &&
        rect.y < 400 &&
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
        (text === "+" ||
          aria.includes("Add") ||
          aria.includes("追加") ||
          cls.includes("add")) &&
        rect.y > 0 &&
        rect.y < 400 &&
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

  await sleep(1500);

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
    await sleep(250);
    await editables.nth(editableCount - 1).click();
    await editables.nth(editableCount - 1).fill(textToType);
  }

  await sleep(700);

  if (gifFilePath && fs.existsSync(gifFilePath)) {
    const fileInput = page.locator('input[type="file"]').first();
    if ((await fileInput.count()) > 0) {
      await fileInput.setInputFiles(gifFilePath);
      await sleep(2200);
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
          t.includes("投稿") ||
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

  await sleep(3000);
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
