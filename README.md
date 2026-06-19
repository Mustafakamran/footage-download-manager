# Footage Downloader

A desktop app for downloading large RAW video assets (SLOG/CLOG, 300–500 GB+)
that clients share with you on **Google Drive** ("Shared with me") and **Dropbox**,
straight to a connected external drive — with multi-account profiles, live progress,
tuned throughput, and hash-verified transfers.

Built with **Tauri 2** (Rust core) + **React/TypeScript/Tailwind**, using **rclone**
as the download engine (bundled). Runs on **Windows** (primary) and **macOS**.

---

## How it works

- The app starts the bundled `rclone` as a local remote-control daemon. All cloud
  access goes through it (proper Drive/Dropbox APIs, ranged multi-thread streams for
  big single files, parallel file transfers, hash verification).
- Each connected account = one rclone remote = one **profile tab**.
- Downloads run in the daemon, independent of which tab you're viewing; the global
  **Transfers** dock shows every job's progress, speed, and ETA.
- Your OAuth credentials live in the OS keychain (Windows Credential Manager / macOS
  Keychain). Account tokens live in rclone's config in the app data dir.

---

## Prerequisites (dev / building)

- **Node.js 18+** and **Rust** (stable, via [rustup](https://rustup.rs)).
- **Windows:** WebView2 (preinstalled on Win 10/11) + **Visual Studio C++ Build Tools**
  (for the Rust MSVC toolchain).
- **macOS:** Xcode Command Line Tools.

## Setup & run

```bash
npm install
npm run fetch:rclone      # downloads the rclone binary for your OS into src-tauri/binaries
npm run tauri dev         # launches the app
```

Build a distributable installer (run on the target OS — build Windows on the Windows PC):

```bash
npm run tauri build
```

---

## One-time: create your own OAuth credentials

The app uses **your own** OAuth app credentials (your dedicated API quota = consistent
speed, no shared-client rate limits). You enter them once in **Settings**.

### Google Drive

1. Open the [Google Cloud Console](https://console.cloud.google.com/) → create a project.
2. **APIs & Services → Library →** enable **Google Drive API**.
3. **OAuth consent screen:** User type **External**. Add yourself as a **Test user**
   (Testing mode), or **Publish** to Production. Scope needed: `.../auth/drive.readonly`.
4. **Credentials → Create credentials → OAuth client ID → Application type: Desktop app.**
5. Copy the **Client ID** and **Client secret**.
6. In the app: **Settings → Google Drive API →** paste both → **Save**.

> Note: `drive.readonly` is a "restricted" scope. For personal/own-account use, Testing
> mode (with yourself as a test user) or unverified Production works fine — you'll click
> through a one-time "unverified app" screen on first sign-in; tokens then persist.

### Dropbox

1. Open the [Dropbox App Console](https://www.dropbox.com/developers/apps) → **Create app**.
2. **Scoped access**, access type **Full Dropbox** (or App folder if that fits).
3. Under **Permissions**, enable the read scopes rclone needs:
   `account_info.read`, `files.metadata.read`, `files.content.read`, `sharing.read`.
4. On the **Settings** tab, copy the **App key** and **App secret**.
5. In the app: **Settings → Dropbox API →** paste both → **Save**.

---

## Using it

1. **Settings:** set a **default download folder** (your external drive, e.g. `E:\Footage`)
   and pick a **Performance** preset (**Turbo** for a fast line; **Gentle** to share the
   pipe). Tune parallel files / streams-per-file / cutoff / bandwidth if you like.
2. **Accounts → Add Google Drive / Add Dropbox →** name the account (e.g. "Client A") →
   a browser opens for sign-in/consent → the account appears as a profile tab.
3. **Open a profile tab →** browse "Shared with me" (Drive) or your Dropbox; sizes show
   per file; multi-select files/folders; the bar shows the total selected size.
4. **Download** → goes to your default folder (or pick one). Watch the **Transfers** dock;
   downloads keep running while you browse other profiles.

---

## Performance notes

- The lever for a single 300 GB+ file is **streams per file** (multi-thread streams);
  parallel-files helps batches of many files.
- True ceiling is the smallest of: your internet line, the provider's per-account
  throttle, and your **external-drive write speed**. The status bar shows live throughput.
- Every transfer is hash-verified by rclone (Drive MD5 / Dropbox content-hash).

## Project layout

- `src/` — React UI (components, Zustand stores, rc client, tauri command wrappers).
- `src-tauri/src/` — Rust: `rclone/` (supervisor + rc client), `accounts.rs`, `download.rs`,
  `secrets.rs` (keychain).
- `docs/superpowers/` — design spec and implementation plan.

## Tests

```bash
npm test                                              # frontend (Vitest)
cargo test --manifest-path src-tauri/Cargo.toml       # Rust (incl. real local-copy integration test)
```
