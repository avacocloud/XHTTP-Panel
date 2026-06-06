import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execFileSync, execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Possible deno binary locations
const DENO_PATHS = ["/root/.deno/bin/deno", "/usr/local/bin/deno", "/usr/bin/deno"];

function findDenoBin(): string | null {
  for (const p of DENO_PATHS) {
    try {
      execFileSync(p, ["--version"], { timeout: 5000 });
      return p;
    } catch {}
  }
  // Also try PATH
  try {
    const which = execSync("which deno", { timeout: 5000, encoding: "utf8" }).trim();
    if (which) return which;
  } catch {}
  return null;
}

function runDenoCmd(args: string[], cwd?: string): string {
  const bin = findDenoBin();
  if (!bin) {
    throw new Error(
      "Deno CLI is not installed on the server. " +
      "Please install it: curl -fsSL https://deno.land/install.sh | sh"
    );
  }
  try {
    const out = execFileSync(bin, args, {
      cwd,
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, NO_COLOR: "1" },
    });
    return out;
  } catch (err: any) {
    const msg = (err.stderr || err.stdout || err.message || String(err)).trim();
    throw new Error(msg);
  }
}

const DENO_API = "https://api.deno.com/v2";

async function denoApi<T>(
  token: string,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const resp = await fetch(`${DENO_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({})) as { message?: string };
    throw new Error(err.message || `Deno API HTTP ${resp.status}`);
  }
  const text = await resp.text();
  return text ? JSON.parse(text) : ({} as T);
}

export interface DenoDeployParams {
  apiToken: string;
  orgName?: string; // optional — no longer required
  projectName: string;
  targetDomain: string;
  relayPath: string;
  publicPath: string;
}

export async function deployToDeno(
  params: DenoDeployParams
): Promise<{ url: string; projectId: string }> {
  const slug = params.projectName.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const tmpDir = mkdtempSync(resolve(tmpdir(), "deno-deploy-"));

  try {
    // ── Step 1: Resolve org name from API (required for CLI --org flag) ───────
    let orgName = params.orgName?.trim() || "";
    try {
      const orgs = await denoApi<Array<{ id: string; name: string }>>(
        params.apiToken, "GET", "/organizations"
      );
      if (orgs.length > 0 && !orgName) orgName = orgs[0].name;
    } catch {
      // Non-fatal — will try without --org
    }

    if (!orgName) {
      throw new Error(
        "Could not determine Deno organization name. " +
        "Please add your org name in the token settings (Org Name field)."
      );
    }

    // ── Step 2: Write relay code to temp dir ──────────────────────────────────
    const srcPath = resolve(__dirname, "../resources/deno-main.ts");
    writeFileSync(resolve(tmpDir, "main.ts"), readFileSync(srcPath, "utf8"), "utf8");

    // ── Step 3: Create or update app via CLI ──────────────────────────────────
    // First try `deno deploy create` (new app); if app already exists, fall
    // back to `deno deploy` (update existing app).
    let appSlug = slug;
    try {
      runDenoCmd(
        [
          "deploy", "create",
          `--token=${params.apiToken}`,
          `--org=${orgName}`,
          `--app=${slug}`,
          "--source=local",
          "--entrypoint=main.ts",
          "--no-wait",
          ".",
        ],
        tmpDir
      );
    } catch (createErr: any) {
      const msg = String(createErr).toLowerCase();
      const alreadyExists =
        msg.includes("already") || msg.includes("conflict") ||
        msg.includes("taken") || msg.includes("exists");
      if (!alreadyExists) throw createErr;

      // App already exists — redeploy with `deno deploy`
      runDenoCmd(
        [
          "deploy",
          `--token=${params.apiToken}`,
          `--org=${orgName}`,
          `--app=${slug}`,
          "--prod",
          "--no-wait",
          ".",
        ],
        tmpDir
      );
    }

    // ── Step 4: Set env vars via API ──────────────────────────────────────────
    await denoApi(params.apiToken, "PATCH", `/apps/${appSlug}`, {
      env_vars: [
        { key: "TARGET_DOMAIN",    value: `https://${params.targetDomain.includes(":") ? params.targetDomain : params.targetDomain + ":443"}`, secret: false },
        { key: "RELAY_PATH",       value: params.relayPath,                 secret: false },
        { key: "PUBLIC_RELAY_PATH",value: params.publicPath,                secret: false },
      ],
    });

    // ── Step 5: Build URL  (format: APP.ORG.deno.net) ─────────────────────────
    const url = `https://${appSlug}.${orgName}.deno.net`;

    return { url, projectId: appSlug };
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch {}
  }
}

export async function deleteDenoProject(
  apiToken: string,
  projectId: string
): Promise<void> {
  // projectId is stored as slug (or legacy "org/app" format)
  const slug = projectId.includes("/")
    ? projectId.split("/")[1]
    : projectId;
  try {
    await denoApi(apiToken, "DELETE", `/apps/${slug}`);
  } catch {
    // Ignore — app may already be deleted
  }
}

export async function testDenoToken(
  apiToken: string,
  orgName?: string
): Promise<{ valid: boolean; detail: string }> {
  // Validate token format (must start with ddo_)
  if (!apiToken || !apiToken.startsWith("ddo_")) {
    return {
      valid: false,
      detail: 'Invalid token format — Deno Deploy tokens must start with "ddo_"',
    };
  }

  // Use Deno Deploy REST API v2 — verify token via /organizations
  try {
    // Try fetching organizations (most reliable check for ddo_ tokens)
    const orgsResp = await fetch("https://api.deno.com/v2/organizations", {
      headers: { Authorization: `Bearer ${apiToken}` },
    });

    if (orgsResp.ok) {
      const orgs = (await orgsResp.json()) as Array<{ id: string; name: string }>;
      const orgNames = orgs.map((o) => o.name).join(", ") || "personal";
      const detail = `Deno token valid — org(s): ${orgNames}`;
      return { valid: true, detail };
    }

    // Fallback: try /apps endpoint
    const appsResp = await fetch("https://api.deno.com/v2/apps", {
      headers: { Authorization: `Bearer ${apiToken}` },
    });

    if (appsResp.ok) {
      const apps = (await appsResp.json()) as Array<{ slug?: string }>;
      const detail = orgName
        ? `Deno token valid — org: ${orgName}, ${apps.length} app(s)`
        : `Deno token valid — ${apps.length} app(s) found`;
      return { valid: true, detail };
    }

    const errBody = await orgsResp.json().catch(() => ({})) as { message?: string };
    return { valid: false, detail: errBody.message || `HTTP ${orgsResp.status}` };
  } catch (err: any) {
    return { valid: false, detail: String(err).slice(0, 200) };
  }
}
