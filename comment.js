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
  return page.evaluate((doneKeys) => {
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

      // クリック対象を最も内側のボタン/リンク/要素に寄せる
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
      clickable.scrollIntoView({ behavior: "instant", block: "center", inline: "nearest" });

      try {
        clickable.click();
      } catch (_) {
        clickable.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      }

      return { opened: true, key };
    }

    return { opened: false, key: null };
  }, Array.from(processedKeys));
}

async function findCommentInputLocator(page) {
  // 画面上の表示中テキスト入力/contenteditable候補からコメント欄らしいものを優先取得
  const candidates = page.locator(
    'textarea:visible, div[contenteditable="true"]:visible, input[type="text"]:visible'
  );
  const count = await candidates.count();
  if (count === 0) return null;

  let bestIdx = -1;
  let bestScore = -9999;

  for (let i = 0; i < count; i++) {
    const loc = candidates.nth(i);
    const info = await loc
      .evaluate((el) => {
        const rect = el.getBoundingClientRect();
        const ph = (el.getAttribute("placeholder") || "").toLowerCase();
        const aria = (el.getAttribute("aria-label") || "").toLowerCase();
        const containerText = (
          el.closest('[role="dialog"], [class*="comment"], [class*="Comment"], form, aside, section, article')
            ?.innerText || ""
        ).toLowerCase();

        const isCommentHint =
          ph.includes("comment") ||
          ph.includes("コメント") ||
          aria.includes("comment") ||
          aria.includes("コメント") ||
          containerText.includes("add comment") ||
          containerText.includes("コメントを追加") ||
          containerText.includes("comments");

        return {
          y: rect.y,
          area: rect.width * rect.height,
          isCommentHint
        };
      })
      .catch(() => null);

    if (!info || info.area <= 0) continue;

    let score = 0;
    if (info.isCommentHint) score += 100;
    // 画面下部・モーダル内にある入力欄をやや優先（後ろに出てきた要素ほどスコアを加算）
    score += i * 5;
    if (info.y > 120) score += 10;

    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  return bestIdx >= 0 ? candidates.nth(bestIdx) : candidates.nth(count - 1);
}

async function clickCommentSubmitButton(page) {
  const clickedByEval = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
    const exactLabels = new Set(["コメント", "comment", "送信", "send", "post", "投稿"]);
    const partialHints = ["comment", "コメント", "send", "送信", "submit"];

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

      // 「コメントを追加」などの開くボタンは除外
      if (tl.includes("add comment") || t.includes("コメントを追加")) continue;

      let score = 0;
      if (exactLabels.has(tl) || exactLabels.has(t)) {
        score += 100;
      } else if (partialHints.some((h) => tl.includes(h) || a.includes(h) || title.includes(h))) {
        score += 60;
      }

      if (score > 0) {
        score += i; // DOMの後ろ側（開いたコメントフォーム側）を優先
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

    await sleep(1200);

    for (let r = 1; r <= repeatPerPost; r++) {
      const editor = await findCommentInputLocator(page);
      if (!editor || (await editor.count()) === 0) {
        await page.keyboard.press("Escape").catch(() => {});
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
        await page.keyboard.press("Escape").catch(() => {});
      }
    }

    await page.keyboard.press("Escape").catch(() => {});
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
