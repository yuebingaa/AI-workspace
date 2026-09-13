import { chromium } from "playwright-core";
import { pathToFileURL } from "node:url";

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  throw new Error("Usage: node scripts/render-architecture-svg.mjs <input.svg> <output.png>");
}

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
});

try {
  const page = await browser.newPage({
    viewport: { width: 2000, height: 1440 },
    deviceScaleFactor: 1,
  });
  await page.goto(pathToFileURL(inputPath).href);
  await page.screenshot({
    path: outputPath,
    clip: { x: 0, y: 0, width: 2000, height: 1440 },
    timeout: 60_000,
  });
} finally {
  await browser.close();
}
