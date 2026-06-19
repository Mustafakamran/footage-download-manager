import { execSync, spawnSync } from "node:child_process";
import { mkdirSync, createWriteStream, existsSync, rmSync, renameSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const RCLONE_VERSION = "v1.69.1"; // pin a known-good release

const triple = execSync("rustc -vV")
  .toString()
  .split("\n")
  .find((l) => l.startsWith("host:"))
  .replace("host:", "")
  .trim();

const map = {
  "x86_64-pc-windows-msvc": { os: "windows", arch: "amd64", ext: ".exe", zext: ".zip" },
  "aarch64-apple-darwin": { os: "osx", arch: "arm64", ext: "", zext: ".zip" },
  "x86_64-apple-darwin": { os: "osx", arch: "amd64", ext: "", zext: ".zip" },
};
const target = map[triple];
if (!target) throw new Error(`Unsupported triple: ${triple}`);

const outDir = join("src-tauri", "binaries");
mkdirSync(outDir, { recursive: true });
const finalPath = join(outDir, `rclone-${triple}${target.ext}`);
if (existsSync(finalPath)) {
  console.log(`rclone sidecar already present: ${finalPath}`);
  process.exit(0);
}

const assetBase = `rclone-${RCLONE_VERSION}-${target.os}-${target.arch}`;
const url = `https://downloads.rclone.org/${RCLONE_VERSION}/${assetBase}${target.zext}`;
const work = join(tmpdir(), `rclone-dl-${process.pid}`);
mkdirSync(work, { recursive: true });
const zipPath = join(work, "rclone.zip");

console.log(`Downloading ${url}`);
const res = await fetch(url);
if (!res.ok) throw new Error(`Download failed: ${res.status}`);
await pipeline(Readable.fromWeb(res.body), createWriteStream(zipPath));

if (process.platform === "win32") {
  spawnSync("powershell", ["-Command", `Expand-Archive -Path '${zipPath}' -DestinationPath '${work}' -Force`], { stdio: "inherit" });
} else {
  spawnSync("unzip", ["-o", zipPath, "-d", work], { stdio: "inherit" });
}

const extractedDir = join(work, assetBase);
const binName = process.platform === "win32" ? "rclone.exe" : "rclone";
renameSync(join(extractedDir, binName), finalPath);
if (process.platform !== "win32") execSync(`chmod +x '${finalPath}'`);
rmSync(work, { recursive: true, force: true });
console.log(`Sidecar ready: ${finalPath}`);
