// FDM Downloader — popup logic
//
// Lets the user paste the pairing token + port (persisted in
// chrome.storage.local) and test the connection against FDM's /fdm/ping.

const DEFAULT_PORT = 53713;

const $token = document.getElementById("token");
const $port = document.getElementById("port");
const $save = document.getElementById("save");
const $test = document.getElementById("test");
const $reveal = document.getElementById("reveal");
const $status = document.getElementById("status");
const $msg = $status.querySelector(".msg");

function setStatus(state, text) {
  $status.classList.remove("ok", "fail");
  if (state === "ok") $status.classList.add("ok");
  else if (state === "fail") $status.classList.add("fail");
  $msg.textContent = text;
}

// ---- Load persisted config --------------------------------------------------

async function load() {
  const { fdmToken = "", fdmPort = DEFAULT_PORT } = await chrome.storage.local.get([
    "fdmToken",
    "fdmPort",
  ]);
  $token.value = fdmToken;
  $port.value = fdmPort || DEFAULT_PORT;
}

// ---- Save -------------------------------------------------------------------

async function save() {
  const fdmToken = $token.value.trim();
  let fdmPort = parseInt($port.value, 10);
  if (!Number.isFinite(fdmPort) || fdmPort < 1 || fdmPort > 65535) {
    fdmPort = DEFAULT_PORT;
    $port.value = DEFAULT_PORT;
  }
  await chrome.storage.local.set({ fdmToken, fdmPort });
  setStatus("", fdmToken ? "Saved. Click Test connection." : "Saved (no token yet).");
}

// ---- Test connection --------------------------------------------------------

function test() {
  const port = parseInt($port.value, 10) || DEFAULT_PORT;
  setStatus("", "Testing…");
  chrome.runtime.sendMessage({ type: "fdm:ping", port }, (res) => {
    const err = chrome.runtime.lastError;
    if (err || !res || !res.ok) {
      setStatus(
        "fail",
        "Can't reach FDM. Make sure the app is running and the port matches."
      );
      return;
    }
    const v = res.version ? ` (v${res.version})` : "";
    if (!$token.value.trim()) {
      setStatus("ok", `FDM is running${v}. Now paste a token and Save.`);
    } else {
      setStatus("ok", `Connected to FDM${v}.`);
    }
  });
}

// ---- Wire up ----------------------------------------------------------------

$save.addEventListener("click", save);
$test.addEventListener("click", async () => {
  // Persist before testing so the background uses fresh values.
  await save();
  test();
});

$reveal.addEventListener("click", () => {
  $token.type = $token.type === "password" ? "text" : "password";
});

// Save automatically when the popup closes / loses focus, so a pasted token
// isn't lost if the user forgets to click Save.
window.addEventListener("blur", save);

load();
