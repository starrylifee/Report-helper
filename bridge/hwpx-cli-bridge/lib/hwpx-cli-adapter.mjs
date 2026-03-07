import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const CONFIG = {
  hwpToHwpxCmd: process.env.HWPXCLI_HWP_TO_HWPX_CMD || "",
  readCmd: process.env.HWPXCLI_READ_CMD || ""
};

export function getCapabilities() {
  return {
    normalizeHwp: Boolean(CONFIG.hwpToHwpxCmd),
    previewPdf: Boolean(CONFIG.readCmd),
    exportHwpx: false
  };
}

export async function normalizeToHwpx({ buffer, fileName, sourceType }) {
  if (sourceType === "hwpx") {
    return {
      normalizedName: ensureHwpxName(fileName),
      normalizedBuffer: buffer
    };
  }

  if (!CONFIG.hwpToHwpxCmd) {
    throw new Error("HWPXCLI_HWP_TO_HWPX_CMD is not configured");
  }

  const tempRoot = await mkdtemp(path.join(tmpdir(), "minuteflow-open-"));
  const inputPath = path.join(tempRoot, fileName);
  const outputPath = path.join(tempRoot, ensureHwpxName(fileName));

  try {
    await writeFile(inputPath, buffer);
    await runTemplateCommand(CONFIG.hwpToHwpxCmd, {
      input: inputPath,
      output: outputPath
    });

    return {
      normalizedName: path.basename(outputPath),
      normalizedBuffer: await readFile(outputPath)
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

export async function extractPlainText({ buffer, fileName }) {
  if (!CONFIG.readCmd) {
    throw new Error("HWPXCLI_READ_CMD is not configured");
  }

  const tempRoot = await mkdtemp(path.join(tmpdir(), "minuteflow-read-"));
  const inputPath = path.join(tempRoot, ensureHwpxName(fileName));

  try {
    await writeFile(inputPath, buffer);
    const output = await runTemplateCommand(CONFIG.readCmd, { input: inputPath });
    return output.stdout.trim();
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function ensureHwpxName(fileName) {
  return String(fileName).replace(/\.(hwp|hwpx)$/i, ".hwpx");
}

function runTemplateCommand(template, replacements) {
  const command = template.replace(/\{(\w+)\}/g, (_, key) => {
    const value = replacements[key];
    if (value === undefined) {
      throw new Error(`missing template value: ${key}`);
    }
    return value;
  });

  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr || `command failed: ${command}`));
      }
    });
  });
}
