use rand::distr::{Alphanumeric, Distribution};
use std::net::TcpListener;

pub struct RcConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub pass: String,
    /// Absolute path to the rclone config file so remotes/tokens persist.
    pub config_path: String,
}

/// Build the argument vector for `rclone rcd`.
pub fn build_rcd_args(cfg: &RcConfig) -> Vec<String> {
    vec![
        "rcd".into(),
        "--rc-addr".into(),
        format!("{}:{}", cfg.host, cfg.port),
        "--rc-user".into(),
        cfg.user.clone(),
        "--rc-pass".into(),
        cfg.pass.clone(),
        "--config".into(),
        cfg.config_path.clone(),
    ]
}

/// Ask the OS for a free loopback port by binding to :0 then releasing it.
// NOTE: There is an intentional, acceptable TOCTOU window here: the listener is
// dropped (freeing the port) before rclone re-binds it. A collision is vanishingly
// unlikely on loopback for a short-lived helper; do not "fix" this with a held socket.
pub fn pick_free_port() -> std::io::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    Ok(port)
}

/// Generate a random alphanumeric secret of the given length.
pub fn random_secret(len: usize) -> String {
    Alphanumeric
        .sample_iter(&mut rand::rng())
        .take(len)
        .map(char::from)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_rcd_args_with_addr_and_auth() {
        let cfg = RcConfig {
            host: "127.0.0.1".into(),
            port: 5572,
            user: "u".into(),
            pass: "p".into(),
            config_path: "/tmp/rclone.conf".into(),
        };
        let args = build_rcd_args(&cfg);
        assert_eq!(args[0], "rcd");
        assert!(args.contains(&"--rc-addr".to_string()));
        assert!(args.contains(&"127.0.0.1:5572".to_string()));
        assert!(args.contains(&"--rc-user".to_string()));
        assert!(args.contains(&"u".to_string()));
        assert!(args.contains(&"--rc-pass".to_string()));
        assert!(args.contains(&"p".to_string()));
        assert!(args.contains(&"--config".to_string()));
        assert!(args.contains(&"/tmp/rclone.conf".to_string()));
    }
}

#[cfg(test)]
mod cred_tests {
    use super::*;

    #[test]
    fn pick_free_port_returns_nonzero() {
        let port = pick_free_port().unwrap();
        assert!(port > 0);
    }

    #[test]
    fn random_secret_has_requested_length_and_is_alnum() {
        let s = random_secret(32);
        assert_eq!(s.len(), 32);
        assert!(s.chars().all(|c| c.is_ascii_alphanumeric()));
    }
}
