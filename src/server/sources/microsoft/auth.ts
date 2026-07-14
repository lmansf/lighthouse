/**
 * Microsoft Entra (Azure AD) authentication for the SharePoint connector.
 *
 * Uses the OAuth 2.0 **device code flow**: the user is shown a short code and a
 * URL, signs in on any browser, and the app polls for the token. This needs no
 * redirect URI and no client secret — it's a public client (PKCE-class) — so it
 * works inside the desktop webview and in the plain web build alike.
 *
 * Tokens live in `connectors/microsoft.json` under the vault state dir — the
 * user's own credential on their own machine, never shipped in the app bundle,
 * exactly like the existing model API key in profile.json.
 */
import fs from "node:fs";
import path from "node:path";
import {
  connectorsDir,
  SHAREPOINT_CLIENT_ID,
  SHAREPOINT_AUTHORITY,
  readJson,
  writeJson,
} from "../../config";

// Device-code endpoints hang off the v2.0 path under the configured authority
// base (e.g. https://login.microsoftonline.com/common + /oauth2/v2.0).
const AUTHORITY = `${SHAREPOINT_AUTHORITY.replace(/\/$/, "")}/oauth2/v2.0`;
/** Delegated Graph scopes. offline_access yields a refresh token. */
const SCOPES = ["offline_access", "openid", "profile", "User.Read", "Files.Read.All", "Sites.Read.All"];
/** Refresh a little early so a token never expires mid-request. */
const EXPIRY_SKEW_MS = 60_000;

/** A SharePoint/OneDrive node, cached names-only until the user enables it. */
export interface SpNode {
  /** Node id: `sharepoint::<driveId>::<itemId>`. */
  id: string;
  name: string;
  parentId: string | null;
  driveId: string;
  itemId: string;
  kind: "file" | "folder";
  mimeType?: string;
  size?: number;
  webUrl?: string;
}

export interface MsState {
  account?: { name: string; email: string };
  tokens?: { accessToken: string; refreshToken: string; expiresAt: number };
  /** In-flight device-code session, awaiting the user to approve in a browser. */
  pending?: { deviceCode: string; expiresAt: number; interval: number };
  /** Cached placeholder tree from the last listing. */
  nodes?: SpNode[];
  /** Node ids the user has enabled (mirrored to disk for retrieval). */
  included?: Record<string, boolean>;
  /** Whether the source as a whole is available to retrieval. */
  available?: boolean;
}

const STATE_PATH = () => path.join(connectorsDir(), "microsoft.json");

export function loadState(): MsState {
  return readJson<MsState>(STATE_PATH(), {});
}
export function saveState(s: MsState): void {
  writeJson(STATE_PATH(), s);
}

export function isConnected(): boolean {
  return Boolean(loadState().tokens?.refreshToken);
}

async function postForm(url: string, fields: Record<string, string>): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

/**
 * Begin a device-code sign-in. Returns the user-facing code + URL to display.
 * The flow is then completed by repeated {@link pollDeviceCode} calls.
 */
export async function startDeviceCode(): Promise<{
  userCode: string;
  verificationUri: string;
  message: string;
  expiresIn: number;
  interval: number;
}> {
  const res = await postForm(`${AUTHORITY}/devicecode`, {
    client_id: SHAREPOINT_CLIENT_ID,
    scope: SCOPES.join(" "),
  });
  const data = await res.json();
  if (!res.ok || !data.device_code) {
    throw new Error(data.error_description || data.error || "could not start sign-in");
  }
  const s = loadState();
  s.pending = {
    deviceCode: data.device_code,
    expiresAt: Date.now() + Number(data.expires_in) * 1000,
    interval: Number(data.interval || 5),
  };
  saveState(s);
  return {
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    message: data.message,
    expiresIn: Number(data.expires_in),
    interval: Number(data.interval || 5),
  };
}

/**
 * Poll once for the pending device-code session. Returns `pending` until the
 * user approves, then `connected`; `expired` if the code lapsed; `idle` if there
 * is no session in progress.
 */
export async function pollDeviceCode(): Promise<{
  status: "pending" | "connected" | "expired" | "idle";
  account?: { name: string; email: string };
}> {
  const s = loadState();
  if (!s.pending) return { status: isConnected() ? "connected" : "idle", account: s.account };
  if (Date.now() > s.pending.expiresAt) {
    delete s.pending;
    saveState(s);
    return { status: "expired" };
  }

  const res = await postForm(`${AUTHORITY}/token`, {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    client_id: SHAREPOINT_CLIENT_ID,
    device_code: s.pending.deviceCode,
  });
  const data = await res.json();

  if (res.ok && data.access_token) {
    const next = loadState();
    delete next.pending;
    next.tokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + Number(data.expires_in) * 1000,
    };
    saveState(next);
    const account = await fetchAccount(data.access_token);
    if (account) {
      const after = loadState();
      after.account = account;
      saveState(after);
    }
    return { status: "connected", account: account ?? undefined };
  }
  // authorization_pending / slow_down keep the session open; anything else ends it.
  if (data.error === "authorization_pending" || data.error === "slow_down") {
    return { status: "pending" };
  }
  if (data.error === "expired_token" || data.error === "code_expired") {
    const next = loadState();
    delete next.pending;
    saveState(next);
    return { status: "expired" };
  }
  // Declined / bad request: clear the session and surface as expired (restartable).
  const next = loadState();
  delete next.pending;
  saveState(next);
  return { status: "expired" };
}

/** A valid access token, refreshed if the cached one has expired. Throws if not connected. */
export async function getAccessToken(): Promise<string> {
  const s = loadState();
  if (!s.tokens?.refreshToken) throw new Error("not connected to Microsoft");
  if (s.tokens.accessToken && Date.now() < s.tokens.expiresAt - EXPIRY_SKEW_MS) {
    return s.tokens.accessToken;
  }
  const res = await postForm(`${AUTHORITY}/token`, {
    grant_type: "refresh_token",
    client_id: SHAREPOINT_CLIENT_ID,
    refresh_token: s.tokens.refreshToken,
    scope: SCOPES.join(" "),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    // Refresh token revoked/expired — force a reconnect.
    const next = loadState();
    delete next.tokens;
    saveState(next);
    throw new Error(data.error_description || "Microsoft session expired — reconnect");
  }
  const next = loadState();
  next.tokens = {
    accessToken: data.access_token,
    // MS may or may not rotate the refresh token; keep the old one if absent.
    refreshToken: data.refresh_token || next.tokens?.refreshToken || s.tokens.refreshToken,
    expiresAt: Date.now() + Number(data.expires_in) * 1000,
  };
  saveState(next);
  return data.access_token;
}

async function fetchAccount(accessToken: string): Promise<{ name: string; email: string } | null> {
  try {
    const res = await fetch("https://graph.microsoft.com/v1.0/me", {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const me = await res.json();
    return {
      name: me.displayName || me.userPrincipalName || "SharePoint user",
      email: me.mail || me.userPrincipalName || "",
    };
  } catch {
    return null;
  }
}

/** The directory holding mirrored SharePoint file content for retrieval. */
export function mirrorDir(): string {
  const dir = path.join(connectorsDir(), "sharepoint-mirror");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Sign out: drop tokens, cached listing, inclusion, and any mirrored content. */
export function disconnect(): void {
  saveState({});
  try {
    fs.rmSync(mirrorDir(), { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}
