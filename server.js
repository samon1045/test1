const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runComments(page, { message, commentMessage, commentRepeat = 1, maxPosts = 50 }) {
  const logs = [];
  const textToComment = (commentMessage && commentMessage.trim()) || message || "test";
  const repeatPerPost = Math.max(1, Math.min(10, Number(commentRepeat) || 1));
  let sentCount = 0;

  await page.evaluate(() => {
    const cards = Array.from(
      document.querySelectorAll('[data-testid*="post"], article, [class*="post-card"], [class*="card"]')
    );
    cards.forEach((card, idx) => {
      if (!card.dataset.samonPostId) {
        card.dataset.samonPostId = `post-${idx + 1}`;
      }
    });
  });

  const processedPostIds = new Set();
  let stagnantRounds = 0;
  let postIndex = 0;

  while (postIndex < maxPosts) {
    const targetInfo = await page.evaluate((doneIds) => {
      const doneSet = new Set(doneIds);

      const cards = Array.from(
        document.querySelectorAll('[data-testid*="post"], article, [class*="post-card"], [class*="card"]')
      );

      for (let i = 0; i < cards.length; i++) {
        const card = cards[i];
        const postId = card.dataset.samonPostId || `card-${i + 1}`;
        if (doneSet.has(postId)) continue;

        const triggers = Array.from(
          card.querySelectorAll('button, [role="button"], span, div, input, textarea')
        );
        for (const el of triggers) {
          const rect = el.getBoundingClientRect();
          const t = (el.innerText || "").trim();
          const a = (el.getAttribute("aria-label") || "").toLowerCase();
          const p = (el.getAttribute("placeholder") || "").toLowerCase();
          const isMatch =
            t === "Add comment" ||
            t === "コメントを追加" ||
            t.includes("Add comment") ||
            t.includes("コメントを追加") ||
            a.includes("add comment") ||
            a.includes("comment") ||
            p.includes("comment") ||
            p.includes("コメント");

          if (isMatch && rect.width > 0 && rect.height > 0 && el.children.length <= 3) {
            el.scrollIntoView({ behavior: "instant", block: "center" });
            el.click();
            return { found: true, postId, label: postId };
          }
        }
      }

      const allTriggers = Array.from(document.querySelectorAll('button, [role="button"], span, div'));
      for (let i = 0; i < allTriggers.length; i++) {
        const el = allTriggers[i];
        if (el.dataset.samonCommented === "1") continue;
        const rect = el.getBoundingClientRect();
        const t = (el.innerText || "").trim();
        const a = (el.getAttribute("aria-label") || "").toLowerCase();
        const isMatch =
          t === "Add comment" ||
          t === "コメントを追加" ||
          t.includes("Add comment") ||
          t.includes("コメントを追加") ||
          a.includes("add comment");

        if (isMatch && rect.width > 0 && rect.height > 0 && el.children.length <= 2) {
          const fallbackId = `trigger-${i + 1}`;
          if (doneSet.has(fallbackId)) continue;
          el.dataset.samonCommented = "1";
          el.scrollIntoView({ behavior: "instant", block: "center" });
          el.click();
          return { found: true, postId: fallbackId, label: fallbackId };
        }
      }

      return { found: false, postId: null, label: null };
    }, Array.from(processedPostIds));

    if (!targetInfo.found) {
      const scrolled = await page.evaluate(() => {
        const before = window.scrollY;
        window.scrollBy(0, 700);
        return window.scrollY > before;
      });

      if (scrolled) {
        stagnantRounds = 0;
        await sleep(1000);
        continue;
      }

      stagnantRounds++;
      if (stagnantRounds >= 2) {
        break;
      }
      await sleep(800);
      continue;
    }

    stagnantRounds = 0;
    processedPostIds.add(targetInfo.postId);
    postIndex++;
    await sleep(900);

    for (let r = 1; r <= repeatPerPost; r++) {
      try {
        const editor = page.locator('div[contenteditable="true"], textarea, input[type="text"]').last();
        if ((await editor.count()) === 0) {
          await page.keyboard.press("Escape");
          logs.push({
            type: "comment",
            section: targetInfo.label,
            attempt: r,
            status: "error",
            detail: `${targetInfo.label} (${r}/${repeatPerPost}回目) - コメント入力欄が見つかりませんでした`,
            timestamp: new Date().toISOString()
          });
          break;
        }

        await editor.click();
        await editor.fill(textToComment);
        await sleep(400);

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
                t.includes("コメント") ||
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
          section: targetInfo.label,
          attempt: r,
          status: "ok",
          detail: `${targetInfo.label} (${r}/${repeatPerPost}回目) へコメント送信完了`,
          timestamp: new Date().toISOString()
        });

        await sleep(1100);
      } catch (err) {
        logs.push({
          type: "comment",
          section: targetInfo.label,
          attempt: r,
          status: "error",
          detail: `${targetInfo.label} (${r}/${repeatPerPost}回目) - ${
            err && err.message ? err.message.split("\n")[0] : "コメント送信失敗"
          }`,
          timestamp: new Date().toISOString()
        });
        await page.keyboard.press("Escape").catch(() => {});
        await sleep(600);
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
