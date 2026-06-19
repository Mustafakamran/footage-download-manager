export interface RcConnection {
  base_url: string;
  user: string;
  pass: string;
}

export interface CoreVersion {
  version: string;
  os: string;
  arch: string;
  goVersion: string;
}
