const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "samon-padlet-runner" });
});

async function executePostStep({ roomUrl, message, gifUrl, sectionName, attempt }) {
  await sleep(600);
  return {
    section: sectionName,
    attempt,
    roomUrl,
    message,
    hasGif: Boolean(gifUrl),
    timestamp: new Date().toISOString(),
    note: "ここにPlaywrightなどのブラウザ自動操作ステップを接続します"
  };
}

app.post("/run", async (req, res) => {
  const {
    roomUrl = "",
    message = "",
    gifUrl = "",
    cookie = "",
    repeat = 2,
    sections = ["Section 1", "Section 2"]
  } = req.body || {};

  if (!roomUrl.trim()) {
    return res.status(400).json({ ok: false, error: "roomUrl が指定されていません。" });
  }

  const count = Math.max(1, Math.min(10, Number(repeat) || 2));
  const targetSections = Array.isArray(sections) && sections.length > 0 ? sections : ["Default Section"];
  const logs = [];

  try {
    for (const sec of targetSections) {
      for (let i = 1; i <= count; i++) {
        const result = await executePostStep({
          roomUrl: roomUrl.trim(),
          message,
          gifUrl: gifUrl.trim(),
          sectionName: sec,
          attempt: i
        });
        logs.push(result);
        await sleep(500);
      }
    }

    return res.json({
      ok: true,
      cookieProvided: Boolean(cookie),
      totalSteps: logs.length,
      logs
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "実行中にエラーが発生しました。",
      logs
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
