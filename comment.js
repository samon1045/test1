const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function setEditableValue(locator, text) {
  await locator.click();
  await locator.fill(text);
}

async function runComments(page, { message, commentMessage, commentRepeat = 1, maxPosts = 30 }) {
  const logs = [];
  const textToComment = (commentMessage && commentMessage.trim()) || message || "test";
  const repeatPerPost = Math.max(1, Math.min(10, Number(commentRepeat) || 1));
  let sentCount = 0;

  for (let i = 0; i < maxPosts; i++) {
    const opened = await page.evaluate(() => {
      const allEls = Array.from(document.querySelectorAll('button, [role="button"], span, div'));
      for (const el of allEls) {
        if (el.dataset.samonCommentDone === "1") continue;
        const t = (el.innerText || "").trim();
        const a = el.getAttribute("aria-label") || "";
        if (
          t.includes("Add comment") ||
          t.includes("コメントを追加") ||
          a.toLowerCase().includes("comment")
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
        await sleep(600);

        const sentByButton = await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
          for (const b of buttons) {
            const t = (b.innerText || "").trim();
            const a = (b.getAttribute("aria-label") || "").toLowerCase();
            const rect = b.getBoundingClientRect();
            if (
              rect.width > 0 &&
              rect.height > 0 &&
              (t.includes("コメント") ||
                t.includes("Comment") ||
                t.includes("送信") ||
                a.includes("send") ||
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
          section: `post-${i + 1}`,
          attempt: r,
          status: "ok",
          detail: `post-${i + 1} (${r}/${repeatPerPost}回目) へコメント送信完了`,
          timestamp: new Date().toISOString()
        });
        await sleep(1200);
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
  }

  return {
    sentComments: sentCount,
    logs
  };
}

module.exports = {
  runComments
};
