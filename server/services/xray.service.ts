import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

const INSTALLER_ENV = process.env.INSTALLER_ENV_PATH || "/etc/xhttp-installer/info.env";
const XRAY_CONFIG = process.env.XRAY_CONFIG_PATH || "/usr/local/etc/xray/config.json";

export interface InstallerState {
  domain?: string;
  relayPath?: string;
  uuid?: string;
  platform?: string;
  vercelUrl?: string;
  clientLink?: string;
  [key: string]: string | undefined;
}

export function readInstallerState(): InstallerState {
  if (!existsSync(INSTALLER_ENV)) return {};

  const content = readFileSync(INSTALLER_ENV, "utf-8");
  const state: InstallerState = {};

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    const keyMap: Record<string, string> = {
      CFG_DOMAIN: "domain",
      CFG_RELAY_PATH: "relayPath",
      INBOUND_UUID: "uuid",
      VLESS_UUID: "uuid",
      XHTTP_PATH: "relayPath",
      CFG_PLATFORM: "platform",
      VERCEL_URL: "vercelUrl",
      CLIENT_LINK: "clientLink",
    };

    state[keyMap[key] || key] = value;
  }

  return state;
}

export function readXrayConfig(): object | null {
  if (!existsSync(XRAY_CONFIG)) return null;
  try {
    return JSON.parse(readFileSync(XRAY_CONFIG, "utf-8"));
  } catch {
    return null;
  }
}

export function getConnectionLink(): string | null {
  const state = readInstallerState();
  if (state.clientLink) return state.clientLink;
  if (!state.uuid || !state.domain) return null;

  const path = state.relayPath || "/";
  return `vless://${state.uuid}@${state.domain}:443?encryption=none&security=tls&sni=${state.domain}&type=xhttp&path=${encodeURIComponent(path)}#XHTTP-${state.domain}`;
}

/**
 * Build a config link for a relay host, using CLIENT_LINK as template so all
 * xpadding / alpn / mode / extra params are preserved. Only the host is replaced.
 */
export function buildConfigLinkForHost(host: string, path: string, label: string): string {
  const state = readInstallerState();
  if (!state.uuid) return "";

  if (state.clientLink) {
    try {
      let link = state.clientLink;
      // Replace host in vless://uuid@HOST:PORT
      link = link.replace(/(vless:\/\/[^@]+@)[^:]+(:)/, `$1${host}$2`);
      // Replace sni=
      link = link.replace(/([?&]sni=)[^&]+/, `$1${host}`);
      // Replace host= param
      link = link.replace(/([?&]host=)[^&]+/, `$1${host}`);
      // Replace path= param
      link = link.replace(/([?&]path=)[^&#]+/, `$1${encodeURIComponent(path || "/api")}`);
      // Strip extra (xpadding) — relay doesn't need client-side padding params
      link = link.replace(/[?&]extra=[^&#]+/, "");
      // Replace fragment
      link = link.replace(/#[^#]*$/, `#${label}`);
      return link;
    } catch {}
  }

  // Fallback: build from installer state fields
  const xpadding = state["XPADDING"];
  let extra = "";
  if (xpadding) {
    const obj: Record<string, string | boolean> = {
      xPaddingBytes: xpadding,
      xPaddingObfsMode: true,
    };
    if (state["XPADDING_KEY"]) obj.xPaddingKey = state["XPADDING_KEY"];
    if (state["XPADDING_HEADER"]) obj.xPaddingHeader = state["XPADDING_HEADER"];
    if (state["SC_MAX_POST_BYTES"]) obj.scMaxEachPostBytes = state["SC_MAX_POST_BYTES"];
    extra = `&extra=${encodeURIComponent(JSON.stringify(obj))}`;
  }
  return `vless://${state.uuid}@${host}:443?type=xhttp&security=tls&sni=${host}&host=${host}&fp=chrome&alpn=http/1.1,h2&path=${encodeURIComponent(path || "/api")}&mode=auto&allowInsecure=0${extra}#${label}`;
}

export interface ServerStatus {
  xrayRunning: boolean;
  uptime: string | null;
  sslExpiry: string | null;
  domain: string | null;
}

export function getServerStatus(): ServerStatus {
  const state = readInstallerState();

  let xrayRunning = false;
  let uptime: string | null = null;
  try {
    const output = execSync("systemctl is-active xray 2>/dev/null", { encoding: "utf-8" }).trim();
    xrayRunning = output === "active";
  } catch {
    xrayRunning = false;
  }

  if (xrayRunning) {
    try {
      const statusOutput = execSync("systemctl show xray --property=ActiveEnterTimestamp 2>/dev/null", {
        encoding: "utf-8",
      }).trim();
      const match = statusOutput.match(/ActiveEnterTimestamp=(.+)/);
      if (match) {
        const startTime = new Date(match[1]);
        const diff = Date.now() - startTime.getTime();
        const days = Math.floor(diff / 86400000);
        const hours = Math.floor((diff % 86400000) / 3600000);
        const minutes = Math.floor((diff % 3600000) / 60000);
        uptime = `${days}d ${hours}h ${minutes}m`;
      }
    } catch {}
  }

  let sslExpiry: string | null = null;
  if (state.domain) {
    try {
      const output = execSync(
        `echo | openssl s_client -connect ${state.domain}:443 -servername ${state.domain} 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null`,
        { encoding: "utf-8" }
      ).trim();
      const match = output.match(/notAfter=(.+)/);
      if (match) sslExpiry = match[1];
    } catch {}
  }

  return {
    xrayRunning,
    uptime,
    sslExpiry,
    domain: state.domain || null,
  };
}

export function restartXray(): { success: boolean; message: string } {
  try {
    execSync("systemctl restart xray 2>&1", { encoding: "utf-8" });
    return { success: true, message: "Xray restarted successfully" };
  } catch (err) {
    return { success: false, message: String(err) };
  }
}
