pub mod accounts;
pub mod bdm;
pub mod download;
pub mod drive;
pub mod dropbox;
pub mod filemail;
pub mod frameio;
pub mod hls;
pub mod index;
pub mod ingest;
pub mod locate;
pub mod provider;
pub mod rclone;
pub mod search;
pub mod secrets;
pub mod speedtest;
pub mod stream;
pub mod torrent;
pub mod transfer;
pub mod wetransfer;

use base64::Engine;
use download::{JobsState, NativeJobsState};
use rclone::supervisor::{start_rclone, stop_rclone, RcloneState};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;

/// True once the user has chosen to really quit (tray "Quit" or Settings →
/// Quit). Closing the window normally only HIDES it (downloads keep running);
/// this flag lets the close handler tell a genuine quit apart from a hide.
#[derive(Default)]
struct Quitting(AtomicBool);

/// True once the system tray was built successfully. Close-to-hide is ONLY safe
/// when there's a tray to bring the window back — on a build with no icon (so no
/// tray) hiding would strand the window with no way to reopen it, so there we
/// let close actually close.
#[derive(Default)]
struct TrayReady(AtomicBool);

/// True when the app was launched with `--minimized` (the autostart plugin
/// passes it at login) — the window should stay hidden in the tray instead of
/// being revealed. Read by the frontend (via `start_hidden`) so it skips its
/// first-paint show(), and by the launch failsafe so it doesn't force-show.
#[derive(Default)]
struct StartHidden(AtomicBool);

/// True once the window has actually been shown to the user (frontend first
/// paint, or a tray/Dock reveal). The launch failsafe only force-shows a window
/// that was NEVER revealed — so it can't fight a window the user deliberately
/// closed-to-tray, or one that intentionally started `--minimized`.
#[derive(Default)]
struct Revealed(AtomicBool);

/// Run the shutdown cleanup that must happen on a REAL quit: kill the rclone
/// daemon and clear the HLS segment cache. Idempotent, so it's safe to call
/// from the quit path AND from the window `Destroyed` handler.
fn shutdown_cleanup(app: &tauri::AppHandle) {
    stop_rclone(&app.state::<RcloneState>());
    app.state::<torrent::TorrentState>().stop();
    hls::cleanup(app);
}

/// Magnet links received via the OS handler before the frontend is ready to take
/// them. Buffered here and drained by `take_pending_magnets` on first mount; live
/// links (app already running) also arrive as an `open-magnet` event.
#[derive(Default)]
struct PendingMagnets(std::sync::Mutex<Vec<String>>);

/// Route an incoming deep-link URL: keep only magnets, reveal the window, buffer
/// it for a cold-launch drain, and emit `open-magnet` for a running frontend.
fn handle_magnet(app: &tauri::AppHandle, url: &str) {
    let url = url.trim();
    if !url.to_lowercase().starts_with("magnet:") {
        return; // FDM only claims magnet: links
    }
    show_main_window(app);
    if let Ok(mut buf) = app.state::<PendingMagnets>().0.lock() {
        buf.push(url.to_string());
    }
    let _ = app.emit("open-magnet", url.to_string());
}

/// Drain any magnet links captured before the frontend was listening.
#[tauri::command]
fn take_pending_magnets(state: tauri::State<PendingMagnets>) -> Vec<String> {
    state.0.lock().map(|mut b| std::mem::take(&mut *b)).unwrap_or_default()
}

/// Reveal + focus the main window (from the tray icon / its menu / Dock).
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        app.state::<Revealed>().0.store(true, Ordering::SeqCst);
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// Whether this launch should start hidden to the tray (`--minimized`). The
/// frontend awaits this before its first-paint show() so an autostart-at-login
/// launch comes up silently instead of popping the window.
#[tauri::command]
fn start_hidden(state: tauri::State<StartHidden>) -> bool {
    state.0.load(Ordering::SeqCst)
}

/// Frontend tells us it has revealed the window (called right after its
/// first-paint show()), so the launch failsafe knows a healthy reveal happened
/// and won't fire.
#[tauri::command]
fn mark_revealed(state: tauri::State<Revealed>) {
    state.0.store(true, Ordering::SeqCst);
}

/// Really quit the app: mark quitting (so the close handler doesn't intercept),
/// run cleanup, then exit. Invoked by the Settings "Quit" button.
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.state::<Quitting>().0.store(true, Ordering::SeqCst);
    shutdown_cleanup(&app);
    app.exit(0);
}

#[tauri::command]
async fn rc_call(
    state: tauri::State<'_, RcloneState>,
    endpoint: String,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    // Clone the connection out of the lock synchronously (fast, non-blocking),
    // then run the blocking HTTP call on the blocking-thread pool. This is the
    // hot path for every folder listing / browse call, so keeping it OFF the
    // main thread is what prevents the window from going "Not Responding".
    let conn = state
        .connection
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or_else(|| "rclone not started".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        rclone::supervisor::rc_post(&conn, &endpoint, &params)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Write base64-encoded bytes to a path on disk (used to save an exported review
/// PDF the frontend generates in-memory).
#[tauri::command]
fn write_binary_file(path: String, base64: String) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64.as_bytes())
        .map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| format!("write {path}: {e}"))
}

/// Reveal a local path in the OS file manager (Finder / Explorer / xdg). Used by
/// the Transfers "Open destination" action. Spawns detached so a slow/failing
/// launcher (e.g. Explorer's non-zero exit) never blocks or errors the caller.
#[tauri::command]
fn open_in_file_manager(path: String) -> Result<(), String> {
    let program = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(target_os = "windows") {
        "explorer"
    } else {
        "xdg-open"
    };
    std::process::Command::new(program)
        .arg(&path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("open {path}: {e}"))
}

/// Delete a download's files from disk: the output at `dest/name` (file OR
/// folder) plus any leftover `.fdmpart`. `name` must be a single path segment —
/// an empty, traversing, or separator-bearing name is refused so this can never
/// delete the destination root or escape it. A missing target is a no-op (e.g. a
/// never-started queue item), so "delete files" is always safe to offer.
#[tauri::command]
fn delete_download_files(dest: String, name: String) -> Result<(), String> {
    let leaf = name.trim();
    if leaf.is_empty() || leaf.contains("..") || leaf.contains('/') || leaf.contains('\\') {
        return Err("refusing to delete: unsafe name".into());
    }
    let base = std::path::Path::new(&dest).join(leaf);
    let mut part = base.as_os_str().to_owned();
    part.push(".fdmpart");
    for p in [base, std::path::PathBuf::from(part)] {
        if p.is_dir() {
            std::fs::remove_dir_all(&p).map_err(|e| format!("delete {}: {e}", p.display()))?;
        } else if p.exists() {
            std::fs::remove_file(&p).map_err(|e| format!("delete {}: {e}", p.display()))?;
        }
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // MUST be registered first: it intercepts a second launch before the
        // rest of the app (and a second rclone daemon) can start.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            show_main_window(app);
            // Windows/Linux deliver a magnet click to the running instance as a
            // command-line arg on the second launch; forward it.
            for a in &args {
                if a.to_lowercase().starts_with("magnet:") {
                    handle_magnet(app, a);
                }
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Launch-on-startup. `--minimized` lets a startup launch come up hidden
        // to the tray instead of popping the window (the frontend checks for it).
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .manage(Quitting::default())
        .manage(TrayReady::default())
        .manage(StartHidden::default())
        .manage(Revealed::default())
        .manage(RcloneState::default())
        .manage(torrent::TorrentState::default())
        .manage(PendingMagnets::default())
        .manage(JobsState::default())
        .manage(NativeJobsState::default())
        .manage(accounts::OAuthState::default())
        .manage(index::IndexState::default())
        .manage(stream::StreamState::default())
        .manage(hls::HlsState::default())
        .manage(bdm::BdmState::default())
        .manage(speedtest::SpeedTestState::default())
        .invoke_handler(tauri::generate_handler![
            take_pending_magnets,
            rc_call,
            quit_app,
            start_hidden,
            mark_revealed,
            write_binary_file,
            open_in_file_manager,
            delete_download_files,
            stream::stream_base,
            hls::stream_mode,
            ingest::ingest_token,
            ingest::prepare_extension,
            ingest::reveal_path,
            bdm::bdm_get_config,
            bdm::bdm_set_config,
            accounts::list_accounts,
            accounts::remove_account,
            accounts::add_account,
            accounts::set_secret,
            accounts::get_secret,
            accounts::delete_secret,
            accounts::account_email,
            accounts::add_drive_link,
            accounts::get_or_create_drive_link,
            accounts::get_or_create_team_drive_link,
            accounts::list_shared_drives,
            dropbox::add_dropbox_link,
            download::start_download,
            download::upload_start,
            download::list_jobs,
            download::cancel_job,
            download::clear_finished_jobs,
            download::delete_item,
            download::move_item,
            drive::drive_uploader,
            drive::drive_folder_path,
            drive::drive_resolve_shortcut,
            drive::drive_share_link,
            drive::dropbox_share_link,
            index::index_start,
            index::index_load,
            index::index_recrawl,
            index::index_folder,
            index::index_cancel,
            index::index_get,
            index::index_status,
            index::index_remove,
            search::account_search,
            search::account_recent,
            search::search_all_accounts,
            speedtest::start_speed_test,
            speedtest::cancel_speed_test,
        ])
        .setup(|app| {
            // Magnet deep links (macOS delivers them via an Apple event to the
            // running or launching process; a cold-launch URL is read here too).
            {
                let h = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        handle_magnet(&h, url.as_str());
                    }
                });
                if let Ok(Some(urls)) = app.deep_link().get_current() {
                    for url in urls {
                        handle_magnet(app.handle(), url.as_str());
                    }
                }
            }

            // Window chrome: macOS keeps the native title bar (Overlay style →
            // traffic lights float over the content, configured in tauri.conf).
            // Windows/Linux get our in-app controls instead, so strip the native
            // decorations there. Done before the frontend shows the window.
            #[cfg(not(target_os = "macos"))]
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_decorations(false);
            }

            // System-tray / menu-bar icon: left-click (or "Show") reveals the
            // window; "Quit" is the ONLY thing that actually exits (close just
            // hides — see the CloseRequested handler below). Building the tray is
            // a quick UI call, safe to do synchronously here.
            if let Some(icon) = app.default_window_icon().cloned() {
                let show_i = MenuItem::with_id(app, "show", "Show FDM", true, None::<&str>)?;
                let quit_i = MenuItem::with_id(app, "quit", "Quit FDM", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&show_i, &quit_i])?;
                TrayIconBuilder::with_id("main-tray")
                    .icon(icon)
                    .tooltip("FDM")
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "show" => show_main_window(app),
                        "quit" => {
                            app.state::<Quitting>().0.store(true, Ordering::SeqCst);
                            shutdown_cleanup(app);
                            app.exit(0);
                        }
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            show_main_window(tray.app_handle());
                        }
                    })
                    .build(app)?;
                // Only now is close-to-hide safe: there's a tray to reopen from.
                app.state::<TrayReady>().0.store(true, Ordering::SeqCst);
            }

            // CRITICAL: the setup closure runs on the main thread BEFORE Tauri's
            // event loop starts pumping, so anything blocking here freezes the
            // window at launch. `start_rclone` spawns the large unsigned
            // `rclone.exe` (Windows Defender real-time-scans it on the first
            // launch after every fresh install) and then blocks polling the rcd
            // daemon until it answers — easily several seconds under a Defender
            // scan. Doing that on the setup thread is exactly the startup freeze.
            //
            // Move ALL startup I/O to a background thread: the window paints
            // instantly, the daemon comes up asynchronously, and the frontend
            // (which already tolerates a not-ready daemon and re-loads on the
            // "rclone-ready" event below) catches up once it's live.
            // A login autostart launch passes `--minimized`; record it so the
            // frontend's first-paint show() and the failsafe below both leave the
            // window hidden in the tray.
            if std::env::args().any(|a| a == "--minimized") {
                app.state::<StartHidden>().0.store(true, Ordering::SeqCst);
            }

            // FAILSAFE: the window starts hidden (visible:false) and the
            // frontend reveals it after its first paint — but if that reveal
            // ever fails (JS error, missing capability, webview stall), the
            // app would sit invisible in the task manager forever. Force-show
            // after a short grace period.
            //
            // Guards so the failsafe only rescues a genuinely-stuck launch:
            //  • start_hidden → an intentional --minimized launch; leave hidden.
            //  • Revealed     → the window was already shown once (healthy paint,
            //    or a tray/Dock reveal), so a currently-hidden window means the
            //    user deliberately closed it to the tray — don't pop it back.
            let show_handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(4));
                let start_hidden = show_handle.state::<StartHidden>().0.load(Ordering::SeqCst);
                let revealed = show_handle.state::<Revealed>().0.load(Ordering::SeqCst);
                if start_hidden || revealed {
                    return;
                }
                if let Some(win) = show_handle.get_webview_window("main") {
                    if !win.is_visible().unwrap_or(true) {
                        show_main_window(&show_handle);
                    }
                }
            });

            let handle = app.handle().clone();
            std::thread::spawn(move || {
                match start_rclone(&handle) {
                    Ok(_) => {
                        // Tell the frontend the daemon is live so it can (re)load
                        // accounts/browse — its initial mount may have run before
                        // the daemon was ready and silently shown the empty state.
                        let _ = handle.emit("rclone-ready", ());
                    }
                    Err(e) => eprintln!("rclone failed to start: {e}"),
                }
                // Loopback streaming proxy for the review player (best-effort).
                if let Err(e) = stream::start_stream_server(&handle) {
                    eprintln!("stream server failed to start: {e}");
                }
                // Loopback ingest server for the FDM browser extension (best-effort;
                // a taken port just disables browser ingest, logged inside).
                ingest::start_ingest_server(&handle);
                // Resolve the ffmpeg/ffprobe sidecars + HLS cache dir (best-effort;
                // failure just leaves HLS unavailable and the player uses direct /media).
                hls::setup(&handle);
                // BDM sync agent (no-op until enabled + configured in Settings → Sync).
                bdm::start_agent(&handle);
            });
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // Close hides the window to the tray / menu bar instead of quitting —
            // rclone and any in-flight downloads keep running. A real quit (tray
            // "Quit" / Settings) sets the Quitting flag first, so it falls through
            // and the window actually closes. Minimize is untouched (it doesn't
            // emit CloseRequested).
            tauri::WindowEvent::CloseRequested { api, .. } => {
                // Hide instead of quit — but ONLY when a tray exists to reopen
                // from. Without a tray (icon-less build) let close actually close,
                // so the window can never get stranded invisibly.
                let quitting = window.state::<Quitting>().0.load(Ordering::SeqCst);
                let tray_ready = window.state::<TrayReady>().0.load(Ordering::SeqCst);
                if !quitting && tray_ready {
                    api.prevent_close();
                    let _ = window.hide();
                    // The window is now hidden but the webview keeps running, so
                    // a playing review video would keep its audio going (and HLS
                    // keep transcoding) with no visible UI. Tell the frontend to
                    // pause media while hidden.
                    let _ = window.emit("app-hidden", ());
                }
            }
            tauri::WindowEvent::Destroyed => {
                stop_rclone(&window.state::<RcloneState>());
                // Best-effort: clear the HLS segment cache dir on exit.
                hls::cleanup(window.app_handle());
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |_app, _event| {
            // macOS: clicking the Dock icon while the window is hidden (closed to
            // the tray) sends Reopen — restore the window, matching the platform
            // convention that activating the app brings a window back. `Reopen`
            // is a macOS-only RunEvent variant, so the whole arm is gated (the
            // params are `_`-prefixed so they don't warn on other platforms).
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                show_main_window(_app);
            }
        });
}
