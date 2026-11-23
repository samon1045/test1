const { sleep, setEditableValue } = require("./utils");

async function waitForCommentTargets(page, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('button, [role="button"], a, span, div'));
      return els.some((el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const t = (el.innerText || "").trim().toLowerCase();
        const a = (el.getAttribute("aria-label") || "").toLowerCase();
        const title = (el.getAttribute("title") || "").toLowerCase();
        return (
          t.includes("add comment") ||
          t.includes("コメントを追加") ||
          t === "コメント" ||
          t === "comments" ||
          a.includes("comment") ||
          title.includes("comment")
        );
      });
    });
    if (found) return true;
    await sleep(800);
  }
  return false;
}

async function openNextCommentTarget(page, processedKeys) {
  const targetInfo = await page.evaluate((doneKeys) => {
    const doneSet = new Set(doneKeys || []);
    const els = Array.from(document.querySelectorAll('button, [role="button"], a, span, div'));

    for (const el of els) {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;

      const t = (el.innerText || "").trim();
      const tl = t.toLowerCase();
      const a = (el.getAttribute("aria-label") || "").toLowerCase();
      const title = (el.getAttribute("title") || "").toLowerCase();

      const looksLikeCommentTrigger =
        tl.includes("add comment") ||
        t.includes("コメントを追加") ||
        tl === "comment" ||
        tl === "comments" ||
        t === "コメント" ||
        a.includes("add comment") ||
        a.includes("コメントを追加") ||
        a.includes("comment") ||
        title.includes("comment");

      if (!looksLikeCommentTrigger) continue;
      if (el.children.length > 6) continue;

      const clickable =
        el.closest('button, [role="button"], a') &&
        el.closest('button, [role="button"], a').getBoundingClientRect().width > 0
          ? el.closest('button, [role="button"], a')
          : el;

      const r = clickable.getBoundingClientRect();
      const key = `${Math.round(r.left / 16)}_${Math.round(r.top / 16)}_${(
        clickable.innerText ||
        clickable.getAttribute("aria-label") ||
        ""
      )
        .trim()
        .slice(0, 24)}`;

      if (doneSet.has(key) || clickable.dataset.samonCommentDone === "1") {
        continue;
      }

      clickable.dataset.samonCommentDone = "1";
      clickable.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });

      const updated = clickable.getBoundingClientRect();
      return {
        found: true,
        key,
        x: updated.left + updated.width / 2,
        y: updated.top + updated.height / 2
      };
    }

    return { found: false, key: null, x: 0, y: 0 };
  }, Array.from(processedKeys));

  if (!targetInfo.found) {
    return { opened: false, key: null };
  }

  await sleep(250);
  await page.mouse.move(targetInfo.x, targetInfo.y).catch(() => {});
  await page.mouse.click(targetInfo.x, targetInfo.y).catch(() => {});

  return { opened: true, key: targetInfo.key };
}

async function findCommentInputLocator(page, waitMs = 4500) {
  const selector =
    'textarea:visible, div[contenteditable="true"]:visible, input[type="text"]:visible, [role="textbox"]:visible';
  const start = Date.now();

  while (Date.now() - start < waitMs) {
    const candidates = page.locator(selector);
    const count = await candidates.count().catch(() => 0);

    if (count > 0) {
      let bestIdx = -1;
      let bestScore = -9999;

      for (let i = 0; i < count; i++) {
        const loc = candidates.nth(i);
        const info = await loc
          .evaluate((el) => {
            const rect = el.getBoundingClientRect();
            const ph = (el.getAttribute("placeholder") || "").toLowerCase();
            const aria = (el.getAttribute("aria-label") || "").toLowerCase();
            const dataPh = (el.getAttribute("data-placeholder") || "").toLowerCase();
            const container = el.closest(
              '[role="dialog"], [class*="comment"], [class*="Comment"], [class*="modal"], [class*="Modal"], form, aside'
            );
            const containerText = (container?.innerText || "").toLowerCase();
            const isInDialogOrCommentBox = Boolean(container);

            const isCommentHint =
              ph.includes("comment") ||
              ph.includes("コメント") ||
              aria.includes("comment") ||
              aria.includes("コメント") ||
              dataPh.includes("comment") ||
              dataPh.includes("コメント") ||
              containerText.includes("add comment") ||
              containerText.includes("コメントを追加") ||
              containerText.includes("comments") ||
              containerText.includes("コメント");

            return {
              y: rect.y,
              area: rect.width * rect.height,
              isCommentHint,
              isInDialogOrCommentBox
            };
          })
          .catch(() => null);

        if (!info || info.area <= 0) continue;

        let score = 0;
        if (info.isCommentHint) score += 120;
        if (info.isInDialogOrCommentBox) score += 50;
        score += i * 5;
        if (info.y > 100) score += 10;

        if (score > bestScore) {
          bestScore = score;
          bestIdx = i;
        }
      }

      if (bestIdx >= 0) {
        return candidates.nth(bestIdx);
      }
      return candidates.nth(count - 1);
    }

    await sleep(300);
  }

  return null;
}

async function clickCommentSubmitButton(page) {
  const clickedByEval = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
    const exactLabels = new Set(["コメント", "comment", "送信", "send", "post", "投稿"]);
    const partialHints = ["comment", "コメント", "send", "送信", "submit", "post"];

    const scored = [];

    for (let i = 0; i < buttons.length; i++) {
      const b = buttons[i];
      if (b.disabled || b.getAttribute("aria-disabled") === "true") continue;
      const rect = b.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;

      const t = (b.innerText || "").trim();
      const tl = t.toLowerCase();
      const a = (b.getAttribute("aria-label") || "").toLowerCase();
      const title = (b.getAttribute("title") || "").toLowerCase();

      if (tl.includes("add comment") || t.includes("コメントを追加")) continue;

      let score = 0;
      if (exactLabels.has(tl) || exactLabels.has(t)) {
        score += 100;
      } else if (partialHints.some((h) => tl.includes(h) || a.includes(h) || title.includes(h))) {
        score += 60;
      }

      if (score > 0) {
        score += i;
        scored.push({ el: b, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    if (scored.length > 0) {
      const target = scored[0].el;
      target.scrollIntoView({ behavior: "instant", block: "center" });
      target.click();
      return true;
    }
    return false;
  });

  if (clickedByEval) {
    return true;
  }

  await page.keyboard.press("Enter").catch(() => {});
  return true;
}

async function closeCommentModalIfOpen(page) {
  const closed = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return false;
    const closeBtn = dialog.querySelector(
      'button[aria-label*="close" i], button[aria-label*="閉じる" i], button[title*="close" i], button[title*="閉じる" i]'
    );
    if (closeBtn) {
      closeBtn.click();
      return true;
    }
    return false;
  });

  if (closed) {
    await sleep(400);
  } else {
    await page.keyboard.press("Escape").catch(() => {});
    await sleep(300);
  }
}

async function runComments(page, { message, commentMessage, commentRepeat = 1, maxPosts = 25 }) {
  const logs = [];
  const textToComment = (commentMessage && commentMessage.trim()) || message || "test";
  const repeatPerPost = Math.max(1, Math.min(10, Number(commentRepeat) || 1));
  const processedKeys = new Set();
  let sentCount = 0;
  let targetIndex = 0;

  await waitForCommentTargets(page, 15000);

  while (targetIndex < maxPosts) {
    const res = await openNextCommentTarget(page, processedKeys);

    if (!res.opened) {
      const scrolled = await page.evaluate(() => {
        const before = window.scrollY;
        window.scrollBy(0, 650);
        return window.scrollY > before;
      });
      if (scrolled) {
        await sleep(1000);
        continue;
      }
      break;
    }

    if (res.key) {
      processedKeys.add(res.key);
    }
    targetIndex++;

    for (let r = 1; r <= repeatPerPost; r++) {
      const editor = await findCommentInputLocator(page, 4500);
      if (!editor || (await editor.count()) === 0) {
        await closeCommentModalIfOpen(page);
        logs.push({
          type: "comment",
          section: `post-${targetIndex}`,
          attempt: r,
          status: "error",
          detail: `post-${targetIndex} (${r}/${repeatPerPost}回目) - コメント入力欄が見つかりませんでした`,
          timestamp: new Date().toISOString()
        });
        break;
      }

      try {
        await setEditableValue(editor, textToComment);
        await sleep(500);

        await clickCommentSubmitButton(page);
        await sleep(1300);

        sentCount++;
        logs.push({
          type: "comment",
          section: `post-${targetIndex}`,
          attempt: r,
          status: "ok",
          detail: `post-${targetIndex} (${r}/${repeatPerPost}回目) へコメント送信完了`,
          timestamp: new Date().toISOString()
        });
      } catch (err) {
        logs.push({
          type: "comment",
          section: `post-${targetIndex}`,
          attempt: r,
          status: "error",
          detail: `post-${targetIndex} (${r}/${repeatPerPost}回目) - ${
            err && err.message ? err.message.split("\n")[0] : "コメント送信失敗"
          }`,
          timestamp: new Date().toISOString()
        });
        await closeCommentModalIfOpen(page);
      }
    }

    await closeCommentModalIfOpen(page);
    await sleep(500);
  }

  return {
    sentComments: sentCount,
    logs
  };
}

module.exports = {
  runComments
};
