import cors from "cors";
import express from "express";
import multer from "multer";
import { createTextPreviewPdf } from "./lib/pdf-preview.mjs";
import { extractPlainText, getCapabilities, normalizeToHwpx } from "./lib/hwpx-cli-adapter.mjs";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const port = Number(process.env.PORT || 48153);

app.use(cors());
app.use(express.json({ limit: "10mb" }));

app.get("/api/health", (_request, response) => {
  response.json({
    ok: true,
    engine: "hwpx-cli",
    capabilities: getCapabilities()
  });
});

app.post("/api/hwpx/open", upload.single("source"), async (request, response) => {
  try {
    const sourceFile = request.file;
    const sourceType = String(request.body.sourceType || detectType(sourceFile && sourceFile.originalname));

    if (!sourceFile) {
      response.status(400).json({ error: "missing source file" });
      return;
    }

    if (sourceType !== "hwp" && sourceType !== "hwpx") {
      response.status(400).json({ error: "unsupported source type" });
      return;
    }

    const normalized = await normalizeToHwpx({
      buffer: sourceFile.buffer,
      fileName: sourceFile.originalname,
      sourceType
    });
    const plainText = await extractPlainText({
      buffer: normalized.normalizedBuffer,
      fileName: normalized.normalizedName
    });
    const previewPdf = await createTextPreviewPdf({
      title: normalized.normalizedName,
      body: plainText
    });

    response.json({
      normalizedName: normalized.normalizedName,
      normalizedBytesBase64: normalized.normalizedBuffer.toString("base64"),
      previewPdfBase64: previewPdf.toString("base64")
    });
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : "failed to open hwpx source"
    });
  }
});

app.post("/api/hwpx/export", upload.single("source"), async (_request, response) => {
  response.status(501).json({
    error: "hwpx export is not implemented in the hwpx-cli bridge yet"
  });
});

app.listen(port, () => {
  console.log(`MinuteFlow hwpx-cli bridge listening on http://127.0.0.1:${port}`);
});

function detectType(fileName) {
  const lower = String(fileName || "").toLowerCase();
  if (lower.endsWith(".hwp")) {
    return "hwp";
  }
  return "hwpx";
}
