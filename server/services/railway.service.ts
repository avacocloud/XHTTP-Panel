import { readFileSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execFileSync, execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAILWAY_GQL = "https://backboard.railway.app/graphql/v2";

// ── CLI helpers ───────────────────────────────────────────────────────────────

function findRailwayBin(): string | null {
  const candidates = [
    "/usr/local/bin/railway",
    "/usr/bin/railway",
    "/root/.npm-global/bin/railway",
  ];
  for (const p of candidates) {
    try { execFileSync(p, ["--version"], { timeout: 5000 }); return p; } catch {}
  }
  try {
    const w = execSync("which railway 2>/dev/null", { timeout: 5000, encoding: "utf8" }).trim();
    if (w) return w;
  } catch {}
  try {
    const prefix = execSync("npm config get prefix 2>/dev/null", { timeout: 5000, encoding: "utf8" }).trim();
    if (prefix) {
      const p = `${prefix}/bin/railway`;
      execFileSync(p, ["--version"], { timeout: 5000 });
      return p;
    }
  } catch {}
  return null;
}

function runRailway(args: string[], cwd: string, token: string, timeout = 120_000): string {
  const bin = findRailwayBin();
  if (!bin) {
    throw new Error(
      "Railway CLI not installed. Go to Initial Setup → Phase 2 → Railway CLI → Install."
    );
  }
  try {
    return execFileSync(bin, args, {
      cwd,
      encoding: "utf8",
      timeout,
      env: {
        ...process.env,
        RAILWAY_API_TOKEN: token,
        NO_COLOR: "1",
        CI: "1",
      },
    });
  } catch (err: any) {
    const msg = (err.stderr || err.stdout || err.message || String(err)).trim();
    throw new Error(msg);
  }
}

// ── GraphQL helper ───────────────────────────────────────────────────────────

async function gql<T>(
  token: string,
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const resp = await fetch(RAILWAY_GQL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await resp.json()) as {
    data?: T;
    errors?: Array<{ message: string }>;
  };
  if (json.errors?.length) throw new Error(json.errors[0].message);
  if (!resp.ok) throw new Error(`Railway API HTTP ${resp.status}`);
  return json.data as T;
}

function isUUID(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

// ── Param types ───────────────────────────────────────────────────────────────

export interface RailwayDeployParams {
  apiToken: string;
  projectName: string;
  targetDomain: string;
  relayPath: string;
  publicPath: string;
  region?: string;
  targetPort?: number;
  maxInflight?: number;
  upstreamTimeoutMs?: number;
}

export type RailwayProgressFn = (step: number, total: number, label: string) => void;
export const RAILWAY_DEPLOY_STEPS = 7;

// ── deploy ────────────────────────────────────────────────────────────────────

export async function deployToRailway(
  params: RailwayDeployParams,
  existingProjectId?: string,
  onProgress?: RailwayProgressFn
): Promise<{ url: string; projectId: string }> {
  const TOTAL = RAILWAY_DEPLOY_STEPS;
  const emit = (step: number, label: string) => onProgress?.(step, TOTAL, label);
  const tmpDir = mkdtempSync(resolve(tmpdir(), "railway-deploy-"));

  try {
    // ── Step 1: Prepare files ────────────────────────────────────────────────
    emit(1, "Preparing source files...");
    const srcDir = resolve(__dirname, "../resources/railway");
    mkdirSync(resolve(tmpDir, "src"), { recursive: true });

    writeFileSync(
      resolve(tmpDir, "src/index.js"),
      readFileSync(resolve(srcDir, "src/index.js"), "utf8"),
      "utf8"
    );
    writeFileSync(
      resolve(tmpDir, "package.json"),
      readFileSync(resolve(srcDir, "package.json"), "utf8"),
      "utf8"
    );

    // NOTE: `region` is NOT supported in railway.json (only multiRegionConfig is).
    // Region must be set via GraphQL serviceInstanceUpdate AFTER deploy.
    // See: https://docs.railway.com/guides/manage-services
    const railwayCfg: Record<string, unknown> = {
      $schema: "https://schema.railway.app/railway.schema.json",
      build: { builder: "NIXPACKS" },
      deploy: {
        startCommand: "node src/index.js",
        restartPolicyType: "ON_FAILURE",
        restartPolicyMaxRetries: 10,
      },
    };
    writeFileSync(resolve(tmpDir, "railway.json"), JSON.stringify(railwayCfg, null, 2), "utf8");

    // ── Step 2: Create project ───────────────────────────────────────────────
    emit(2, "Creating Railway project...");

    if (!existingProjectId) {
      try {
        const listData = await gql<{
          projects: { edges: Array<{ node: { id: string; name: string } }> };
        }>(params.apiToken, `{ projects { edges { node { id name } } } }`);
        if (listData.projects?.edges?.length >= 2) {
          throw new Error(
            "Railway free plan limit: you already have 2+ projects. Delete an existing project first, then try again."
          );
        }
      } catch (err: any) {
        if (err.message.includes("free plan") || err.message.includes("Delete an existing")) throw err;
      }
    }

    if (existingProjectId && isUUID(existingProjectId)) {
      runRailway(["link", existingProjectId], tmpDir, params.apiToken);
    } else {
      try {
        // Railway CLI reads workspace from token context — no --workspace flag needed
        runRailway(["init", "--name", params.projectName], tmpDir, params.apiToken);
      } catch (err: any) {
        if (err.message.includes("Free plan") || err.message.includes("provision limit")) {
          throw new Error(
            "Railway free plan limit reached. Delete existing projects from railway.app dashboard or upgrade your plan."
          );
        }
        throw err;
      }
    }

    // ── Step 3: Upload & deploy code ─────────────────────────────────────────
    emit(3, "Uploading & building code (1-2 min)...");
    runRailway(["up", "--ci"], tmpDir, params.apiToken, 600_000);

    // ── Step 3b: Set region via GraphQL (railway.json does NOT support region) ─
    // Must be done after `railway up` so the service + environment IDs exist.
    if (params.region) {
      try {
        // Get project ID from the local .railway/config.toml written by CLI
        let gqlProjectId = "";
        try {
          const cfgRaw = readFileSync(resolve(tmpDir, ".railway", "config.toml"), "utf8");
          const m = cfgRaw.match(/project\s*=\s*"([0-9a-f-]{36})"/i);
          if (m) gqlProjectId = m[1];
        } catch {}

        if (gqlProjectId) {
          // Fetch serviceId and environmentId for this project
          const projData = await gql<{
            project: {
              services: { edges: Array<{ node: { id: string } }> };
              environments: { edges: Array<{ node: { id: string; name: string } }> };
            };
          }>(
            params.apiToken,
            `query ($id: String!) {
              project(id: $id) {
                services { edges { node { id } } }
                environments { edges { node { id name } } }
              }
            }`,
            { id: gqlProjectId }
          );

          const serviceId = projData.project?.services?.edges?.[0]?.node?.id;
          const envEdge = projData.project?.environments?.edges?.find(
            (e) => e.node.name === "production"
          ) ?? projData.project?.environments?.edges?.[0];
          const environmentId = envEdge?.node?.id;

          if (serviceId && environmentId) {
            await gql(
              params.apiToken,
              `mutation ($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) {
                serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
              }`,
              { serviceId, environmentId, input: { region: params.region } }
            );
            emit(3, `Region set to ${params.region} — redeploying...`);
            // Trigger a new deployment so the region change takes effect
            runRailway(["up", "--ci"], tmpDir, params.apiToken, 600_000);
          }
        }
      } catch (regionErr: any) {
        // Non-fatal — deployment still works, just in default region
        console.warn("[Railway] Could not set region via GraphQL:", regionErr.message);
      }
    }

    // ── Step 4: Set environment variables ────────────────────────────────────
    const targetUrl = `https://${params.targetDomain.includes(":") ? params.targetDomain : params.targetDomain + ":" + (params.targetPort || 443)}`;
    emit(4, `Setting environment variables (TARGET=${targetUrl})...`);
    const setArgs: string[] = ["variables"];
    const kvPairs: string[] = [
      `TARGET_DOMAIN=${targetUrl}`,
      `RELAY_PATH=${params.relayPath}`,
      `PUBLIC_RELAY_PATH=${params.publicPath}`,
    ];
    if (params.maxInflight !== undefined && params.maxInflight > 0) {
      kvPairs.push(`MAX_INFLIGHT=${params.maxInflight}`);
    }
    if (params.upstreamTimeoutMs !== undefined) {
      kvPairs.push(`UPSTREAM_TIMEOUT_MS=${params.upstreamTimeoutMs}`);
    }
    for (const kv of kvPairs) setArgs.push("--set", kv);
    runRailway(setArgs, tmpDir, params.apiToken);

    // ── Step 5: Generate domain ──────────────────────────────────────────────
    emit(5, "Generating public domain...");

    let url = "";
    try {
      const domainOut = runRailway(["domain"], tmpDir, params.apiToken);
      const m = domainOut.match(/[\w-]+\.up\.railway\.app/);
      if (m) url = `https://${m[0]}`;
    } catch {}
    if (!url) url = `https://${params.projectName}.up.railway.app`;

    // ── Step 6: Capture project ID ───────────────────────────────────────────
    emit(6, "Capturing Railway project ID...");
    let projectId: string = params.projectName;
    try {
      const cfgContent = readFileSync(resolve(tmpDir, ".railway", "config.toml"), "utf8");
      const m = cfgContent.match(/project\s*=\s*"([0-9a-f-]{36})"/i);
      if (m) projectId = m[1];
    } catch {}
    if (!isUUID(projectId)) {
      try {
        const data = await gql<{
          projects: { edges: Array<{ node: { id: string; name: string } }> };
        }>(params.apiToken, `{ projects { edges { node { id name } } } }`);
        const found = data.projects?.edges?.find((e) => e.node.name === params.projectName);
        if (found) projectId = found.node.id;
      } catch {}
    }

    emit(7, `Railway service live: ${url}`);
    return { url, projectId };
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch {}
  }
}

// ── delete ────────────────────────────────────────────────────────────────────

export async function deleteRailwayProject(
  apiToken: string,
  projectId: string
): Promise<void> {
  try {
    let targetId = projectId;
    if (!isUUID(targetId)) {
      const data = await gql<{
        projects: { edges: Array<{ node: { id: string; name: string } }> };
      }>(apiToken, `{ projects { edges { node { id name } } } }`);
      const found = data.projects?.edges?.find(
        (e) => e.node.name === targetId || e.node.id === targetId
      );
      if (found) targetId = found.node.id;
    }
    if (isUUID(targetId)) {
      await gql(apiToken, `mutation { projectDelete(id: "${targetId}") }`);
    }
  } catch {}
}

// ── test token ────────────────────────────────────────────────────────────────

export async function testRailwayToken(
  apiToken: string
): Promise<{ valid: boolean; detail: string }> {
  try {
    const data = await gql<{ me: { id: string; name: string; email: string } }>(
      apiToken,
      `{ me { id name email } }`
    );
    if (data?.me) {
      const who = data.me.name || data.me.email || data.me.id;
      return { valid: true, detail: `Railway account: ${who}` };
    }
    return { valid: false, detail: "Could not verify token" };
  } catch (err: any) {
    return { valid: false, detail: String(err).slice(0, 200) };
  }
}
