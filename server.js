const express = require("express");
const multer = require("multer");
const archiver = require("archiver");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const { promisify } = require("util");

const execAsync = promisify(exec);
const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const WORKER_SECRET = process.env.PPTX_WORKER_SECRET;
const PORT = process.env.PORT || 8080;

if (!WORKER_SECRET) {
  console.error("Error: PPTX_WORKER_SECRET is required");
  process.exit(1);
}

function auth(req, res, next) {
  const secret = req.headers["x-worker-secret"];
  if (secret !== WORKER_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

app.post("/render", auth, upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "no file" });
  }

  const tmpDir = path.join("/tmp", `render-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const pptxPath = path.join(tmpDir, "deck.pptx");
  fs.writeFileSync(pptxPath, req.file.buffer);

  try {
    // Convert PPTX → PDF via LibreOffice
    await execAsync(
      `soffice --headless --convert-to pdf --outdir "${tmpDir}" "${pptxPath}"`,
      { timeout: 120000 }
    );

    const pdfPath = path.join(tmpDir, "deck.pdf");
    if (!fs.existsSync(pdfPath)) {
      throw new Error("LibreOffice failed to produce a PDF");
    }

    // Convert PDF → PNGs via pdftoppm
    const pngDir = path.join(tmpDir, "slides");
    fs.mkdirSync(pngDir, { recursive: true });

    await execAsync(
      `pdftoppm -png -r 150 "${pdfPath}" "${path.join(pngDir, "slide")}"`,
      { timeout: 120000 }
    );

    // Gather slide PNGs in order
    const files = fs.readdirSync(pngDir)
      .filter((f) => f.endsWith(".png"))
      .sort((a, b) => {
        const na = parseInt(a.match(/(\d+)/)?.[1] ?? "0", 10);
        const nb = parseInt(b.match(/(\d+)/)?.[1] ?? "0", 10);
        return na - nb;
      });

    if (files.length === 0) {
      throw new Error("No slide images produced");
    }

    // Stream ZIP back
    res.setHeader("Content-Type", "application/zip");
    const archive = archiver("zip", { zlib: { level: 6 } });
    archive.pipe(res);

    for (let i = 0; i < files.length; i++) {
      const p = path.join(pngDir, files[i]);
      archive.file(p, { name: `slide-${i}.png` });
    }

    await archive.finalize();
  } catch (err) {
    console.error("[render] error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message ?? "render failed" });
    }
  } finally {
    // Cleanup
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`pptx-render-worker on :${PORT}`);
});
