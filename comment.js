const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function setEditableValue(locator, text) {
  await locator.click();
  await locator.fill(text);
}

async function clickCommentSubmitButton(page) {
  // 1. テキストが「コメント」「Comment」「送信」「Send」のボタンをPlaywrightのLocatorで探してクリック
  const buttonTexts = ["コメント", "Comment", "送信", "Send"];
  for (const label of buttonTexts) {
    const btn = page
      .locator('button, [role="button"]')
      .filter({ hasText: new RegExp(`^${label}$`, "i") });
    const count = await btn.count();
    for (let i = count - 1; i >= 0; i--) {
      const target = btn.nth(i);
      if (await target.isVisible().catch(() => false)) {
        await target.scrollIntoViewIfNeeded().catch(() => {});
        await target.click({ timeout: 3000 }).catch(() => {});
        return true;
      }
    }
  }

  // 2. aria-label 等から送信系ボタンを探索
  const clickedByEval = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
    for (let i = buttons.length - 1; i >= 0; i--) {
      const b = buttons[i];
      const rect = b.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      const t = (b.innerText || "").trim();
      const a = (b.getAttribute("aria-label") || "").toLowerCase();
      if (
        t === "コメント" ||
        t === "Comment" ||
        t === "送信" ||
        t === "Send" ||
        a.includes("comment") ||
        a.includes("send") ||
        a.includes("submit") ||
        a.includes("送信")
      ) {
        b.scrollIntoView({ behavior: "instant", block: "center" });
        b.click();
        return true;
      }
    }
    return false;
  });

  if (clickedByEval) return true;

  // 3. 最終手段として Enter キー
  await page.keyboard.press("Enter");
  return true;
}

async function runComments(page, { message, commentMessage, commentRepeat = 1, maxPosts = 20 }) {
  const logs = [];
  const textToComment = (commentMessage && commentMessage.trim()) || message || "test";
  const repeatPerPost = Math.max(1, Math.min(5, Number(commentRepeat) || 1));
  let sentCount = 0;

  for (let i = 0; i < maxPosts; i++) {
    const opened = await page.evaluate(() => {
      const allEls = Array.from(document.querySelectorAll('button, [role="button"], span, div, a'));
      for (const el of allEls) {
        if (el.dataset.samonCommentDone === "1") continue;
        const t = (el.innerText || "").trim();
        const a = (el.getAttribute("aria-label") || "").toLowerCase();
        if (
          t.includes("Add comment") ||
          t.includes("コメントを追加") ||
          a.includes("add comment") ||
          a.includes("comment")
        ) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0 && el.children.length <= 4) {
            el.dataset.samonCommentDone = "1";
            el.scrollIntoView({ behavior: "instant", block: "center" });
            el.click();
            return true;
          }
        }
      }
      return false;
    });

    if (!opened) {
      const scrolled = await page.evaluate(() => {
        const before = window.scrollY;
        window.scrollBy(0, 600);
        return window.scrollY > before;
      });
      if (scrolled) {
        await sleep(900);
        continue;
      }
      break;
    }

    await sleep(1100);

    for (let r = 1; r <= repeatPerPost; r++) {
      const editor = page.locator('div[contenteditable="true"], textarea, input[type="text"]').last();
      if ((await editor.count()) === 0) {
        await page.keyboard.press("Escape").catch(() => {});
        logs.push({
          type: "comment",
          section: `post-${i + 1}`,
          attempt: r,
          status: "error",
          detail: `post-${i + 1} (${r}/${repeatPerPost}回目) - コメント入力欄が見つかりませんでした`,
          timestamp: new Date().toISOString()
        });
        break;
      }

      try {
        await setEditableValue(editor, textToComment);
        await sleep(500);

        await clickCommentSubmitButton(page);
        await sleep(1200);

        sentCount++;
        logs.push({
          type: "comment",
          section: `post-${i + 1}`,
          attempt: r,
          status: "ok",
          detail: `post-${i + 1} (${r}/${repeatPerPost}回目) へコメント送信完了`,
          timestamp: new Date().toISOString()
        });
      } catch (err) {
        logs.push({
          type: "comment",
          section: `post-${i + 1}`,
          attempt: r,
          status: "error",
          detail: `post-${i + 1} (${r}/${repeatPerPost}回目) - ${
            err && err.message ? err.message.split("\n")[0] : "コメント送信失敗"
          }`,
          timestamp: new Date().toISOString()
        });
        await page.keyboard.press("Escape").catch(() => {});
      }
    }

    // 詳細パネルが開いたまま次のカードクリックを邪魔しないよう、開いていれば閉じる
    await page.keyboard.press("Escape").catch(() => {});
    await sleep(400);
  }

  return {
    sentComments: sentCount,
    logs
  };
}

module.exports = {
  runComments
};
