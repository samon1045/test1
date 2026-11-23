const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runComments(page, { message, maxComments = 50 }) {
  const logs = [];
  const textToComment = message || "test";
  let sentCount = 0;

  // 画面を少しずつスクロールしながら、表示されているコメント追加ボタンを順次処理する
  for (let attempt = 1; attempt <= maxComments; attempt++) {
    const openedIndex = await page.evaluate((skipCount) => {
      const candidates = Array.from(
        document.querySelectorAll('button, [role="button"], span, div')
      ).filter((el) => {
        const t = (el.innerText || "").trim();
        const a = (el.getAttribute("aria-label") || "").toLowerCase();
        const rect = el.getBoundingClientRect();
        const isCommentTrigger =
          t === "Add comment" ||
          t === "コメントを追加" ||
          t.includes("Add comment") ||
          t.includes("コメントを追加") ||
          a.includes("add comment") ||
          a.includes("comment");
        return isCommentTrigger && rect.width > 0 && rect.height > 0 && el.children.length <= 2;
      });

      if (candidates.length === 0) return -1;
      const target = candidates[Math.min(skipCount, candidates.length - 1)];
      target.scrollIntoView({ block: "center" });
      target.click();
      return candidates.length;
    }, 0);

    if (openedIndex === -1) {
      // 下にスクロールして未読込の投稿がないか確認
      const scrolled = await page.evaluate(() => {
        const before = window.scrollY;
        window.scrollBy(0, 600);
        return window.scrollY > before;
      });
      if (!scrolled) break;
      await sleep(1000);
      continue;
    }

    await sleep(1000);

    try {
      const editor = page.locator('div[contenteditable="true"], textarea').last();
      if ((await editor.count()) === 0) {
        await page.keyboard.press("Escape");
        break;
      }

      await editor.click();
      await editor.fill(textToComment);
      await sleep(500);

      const sentByButton = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
        for (const b of buttons) {
          const t = (b.innerText || "").trim();
          const a = (b.getAttribute("aria-label") || "").toLowerCase();
          const rect = b.getBoundingClientRect();
          if (
            rect.width > 0 &&
            rect.height > 0 &&
            (t === "コメント" ||
              t === "Comment" ||
              t === "送信" ||
              a.includes("send") ||
              a.includes("submit comment") ||
              a.includes("送信"))
          ) {
            b.click();
            return true;
          }
        }
        return false;
      });

      if (!sentByButton) {
        await page.keyboard.press("Enter");
      }

      sentCount++;
      logs.push({
        type: "comment",
        section: "All Posts",
        attempt: sentCount,
        status: "ok",
        detail: `投稿 #${sentCount} へコメント送信完了`,
        timestamp: new Date().toISOString()
      });

      await sleep(1500);
    } catch (err) {
      logs.push({
        type: "comment",
        section: "All Posts",
        attempt,
        status: "error",
        detail: err && err.message ? err.message.split("\n")[0] : "コメント送信失敗",
        timestamp: new Date().toISOString()
      });
      await page.keyboard.press("Escape").catch(() => {});
      await sleep(800);
    }
  }

  return {
    sentComments: sentCount,
    logs
  };
}

module.exports = {
  runComments
};
