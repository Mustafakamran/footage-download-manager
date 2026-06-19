//! OS-keychain-backed storage for the user's OAuth app credentials
//! (Google client_id/secret, Dropbox app key/secret). These are reused across
//! every account of a given provider, so they live in the keychain rather than
//! in the rclone config.

use keyring::{Entry, Error as KeyringError};

/// Service name under which all secrets are namespaced in the OS keychain.
const SERVICE: &str = "google-drive-downloader";

/// Store (or overwrite) a secret value under `key`.
pub fn set_secret(key: &str, value: &str) -> Result<(), String> {
    let entry = Entry::new(SERVICE, key).map_err(|e| e.to_string())?;
    entry.set_password(value).map_err(|e| e.to_string())
}

/// Fetch a secret value. Returns `Ok(None)` when no entry exists.
pub fn get_secret(key: &str) -> Result<Option<String>, String> {
    let entry = Entry::new(SERVICE, key).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Delete a secret. A missing entry is treated as success (idempotent).
pub fn delete_secret(key: &str) -> Result<(), String> {
    let entry = Entry::new(SERVICE, key).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(KeyringError::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
