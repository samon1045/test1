const fs = require("fs");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function setEditableValue(locator, text) {
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await locator.click({ timeout: 4000 });

  const tagName = await locator
    .evaluate((el) => (el.tagName || "").toLowerCase())
    .catch(() => "");

  if (tagName === "textarea" || tagName === "input") {
    await locator.fill("");
    await locator.fill(text);
    return;
  }

  // contenteditable 要素向け：全選択して置換してから入力
  await locator.evaluate((el) => {
    el.focus();
    const sel = window.getSelection();
    if (sel) {
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  });
  await locator.page().keyboard.press("Backspace").catch(() => {});
  if (text) {
    await locator.page().keyboard.type(text, { delay: 15 });
  }
}

function cleanupDir(dirPath) {
  if (!dirPath || !fs.existsSync(dirPath)) return;
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch (_) {}
}

function cleanupFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return;
  try {
    fs.unlinkSync(filePath);
  } catch (_) {}
}

module.exports = {
  sleep,
  setEditableValue,
  cleanupDir,
  cleanupFile
};
