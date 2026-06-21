//! Native WeTransfer downloader (anonymous shares), mirroring BDM's
//! `wetransfer_provider.py`. Reverse-engineered web API (no creds):
//!   resolve we.tl 302 → canonical /downloads/<id>/<hash>
//!   POST /api/v4/transfers/<id>/prepare-download {security_hash, intent:entire_transfer} → files
//!   POST /api/v4/transfers/<id>/download {security_hash, intent:single_file, file_ids:[id]} → direct_link (~5min)
//!   Range-stream the direct_link to disk; re-request the link on 403/expiry.

use crate::download::NativeHandles;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::Duration;

const API: &str = "https://wetransfer.com/api/v4/transfers";
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 BilalDriveMan/1.0";

fn client() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .timeout(None)
        .connect_timeout(Duration::from_secs(30))
        .build()
        .unwrap_or_default()
}

/// (transfer_id, security_hash) from a canonical wetransfer.com/downloads URL.
fn parse_canonical(url: &str) -> Option<(String, String)> {
    let i = url.find("/downloads/")?;
    let rest = &url[i + "/downloads/".len()..];
    let rest = rest.split(['?', '#']).next().unwrap_or(rest); // drop query/fragment
    let segs: Vec<&str> = rest.split('/').filter(|s| !s.is_empty()).collect();
    if segs.len() < 2 {
        return None;
    }
    // [transfer_id, (recipient,) security_hash]
    Some((segs[0].to_string(), segs[segs.len() - 1].to_string()))
}

fn resolve(c: &reqwest::blocking::Client, url: &str) -> Result<(String, String), String> {
    if let Some(p) = parse_canonical(url) {
        return Ok(p);
    }
    // we.tl short link → follow redirects, read the final URL.
    let resp = c.get(url).header("User-Agent", UA).send().map_err(|e| e.to_string())?;
    let final_url = resp.url().as_str().to_string();
    parse_canonical(&final_url).ok_or_else(|| format!("couldn't resolve WeTransfer link (final: {final_url})"))
}

fn post(c: &reqwest::blocking::Client, url: &str, body: &Value) -> Result<Value, String> {
    let resp = c
        .post(url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .header("User-Agent", UA)
        .header("X-Requested-With", "XMLHttpRequest")
        .body(serde_json::to_string(body).map_err(|e| e.to_string())?)
        .send()
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("wetransfer {status}: {}", text.chars().take(200).collect::<String>()));
    }
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

/// Files in the transfer: (file_id, name, size). Skips folder entries.
fn prepare(c: &reqwest::blocking::Client, id: &str, hash: &str) -> Result<Vec<(String, String, i64)>, String> {
    let v = post(c, &format!("{API}/{id}/prepare-download"), &json!({ "security_hash": hash, "intent": "entire_transfer" }))?;
    let items = v.get("items").and_then(|i| i.as_array()).cloned().unwrap_or_default();
    let mut out = Vec::new();
    for it in &items {
        if it.get("content_identifier").and_then(|c| c.as_str()) == Some("folder") {
            continue;
        }
        let fid = it.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let name = it.get("name").and_then(|x| x.as_str()).unwrap_or("file").to_string();
        let size = it.get("size").and_then(|x| x.as_i64()).unwrap_or(0);
        if !fid.is_empty() {
            out.push((fid, name, size));
        }
    }
    if out.is_empty() {
        return Err("WeTransfer share has no downloadable files (expired?)".into());
    }
    Ok(out)
}

fn direct_link(c: &reqwest::blocking::Client, id: &str, hash: &str, file_id: &str) -> Result<String, String> {
    let v = post(
        c,
        &format!("{API}/{id}/download"),
        &json!({ "security_hash": hash, "intent": "single_file", "file_ids": [file_id] }),
    )?;
    v.get("direct_link")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "no direct_link in WeTransfer response".into())
}

fn safe_name(name: &str) -> String {
    name.chars().map(|c| if "/\\:*?\"<>|".contains(c) { '_' } else { c }).collect()
}

/// Range-stream one file to dest, resuming from any `.fdmpart`, refreshing the
/// presigned link once on a 403.
fn stream_file(c: &reqwest::blocking::Client, id: &str, hash: &str, file_id: &str, total: i64, dest_file: &Path, h: &NativeHandles) -> Result<(), String> {
    if let Some(p) = dest_file.parent() {
        std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    if total > 0 && std::fs::metadata(dest_file).map(|m| m.len()).unwrap_or(0) == total as u64 {
        h.transferred.fetch_add(total, Ordering::SeqCst);
        return Ok(());
    }
    let mut part = dest_file.as_os_str().to_owned();
    part.push(".fdmpart");
    let part = PathBuf::from(part);
    let mut offset = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    if total > 0 && offset > total as u64 {
        offset = 0;
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .truncate(false)
        .open(&part)
        .map_err(|e| e.to_string())?;
    if offset == 0 {
        let _ = file.set_len(0);
    }
    h.transferred.fetch_add(offset as i64, Ordering::SeqCst);

    let mut link = direct_link(c, id, hash, file_id)?;
    let mut refreshed = false;
    loop {
        if total > 0 && offset >= total as u64 {
            break;
        }
        if h.cancelled.load(Ordering::SeqCst) {
            return Err("paused".into());
        }
        let mut resp = c
            .get(&link)
            .header("User-Agent", UA)
            .header("Range", format!("bytes={offset}-"))
            .send()
            .map_err(|e| e.to_string())?;
        if resp.status().as_u16() == 403 && !refreshed {
            link = direct_link(c, id, hash, file_id)?;
            refreshed = true;
            continue;
        }
        if !resp.status().is_success() {
            return Err(format!("wetransfer download {}", resp.status()));
        }
        let mut buf = vec![0u8; 1 << 20];
        loop {
            if h.cancelled.load(Ordering::SeqCst) {
                return Err("paused".into());
            }
            let n = resp.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            h.transferred.fetch_add(n as i64, Ordering::SeqCst);
        }
        break;
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);
    std::fs::rename(&part, dest_file).map_err(|e| e.to_string())
}

/// Download an entire WeTransfer share into `dest_dir`, updating `h`.
pub fn download_share(url: &str, dest_dir: &Path, h: &NativeHandles) -> Result<(), String> {
    let c = client();
    let (id, hash) = resolve(&c, url)?;
    let files = prepare(&c, &id, &hash)?;
    for (fid, name, size) in files {
        if h.cancelled.load(Ordering::SeqCst) {
            return Err("paused".into());
        }
        let dest_file = dest_dir.join(safe_name(&name));
        stream_file(&c, &id, &hash, &fid, size, &dest_file, h)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_canonical_urls() {
        assert_eq!(
            parse_canonical("https://wetransfer.com/downloads/abcdef0123456789abcd/0123456789?t=1"),
            Some(("abcdef0123456789abcd".into(), "0123456789".into()))
        );
        assert_eq!(
            parse_canonical("https://wetransfer.com/downloads/abcdef0123456789abcd/recipient@x/0123456789"),
            Some(("abcdef0123456789abcd".into(), "0123456789".into()))
        );
        assert_eq!(parse_canonical("https://we.tl/t-xyz"), None);
    }

    #[test]
    fn sanitizes_names() {
        assert_eq!(safe_name("a/b:c*?.mp4"), "a_b_c__.mp4");
    }
}
