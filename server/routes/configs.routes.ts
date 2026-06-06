import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import {
  readXrayConfig,
  getConnectionLink,
  getServerStatus,
  restartXray,
  readInstallerState,
  buildConfigLinkForHost,
} from "../services/xray.service.js";
import { getDb } from "../db/init.js";

const router = Router();

router.get("/xray", requireAuth, (_req, res) => {
  const config = readXrayConfig();
  if (!config) {
    res.status(404).json({ error: "Xray config not found" });
    return;
  }
  res.json(config);
});

router.get("/connection-link", requireAuth, (_req, res) => {
  const link = getConnectionLink();
  if (!link) {
    res.status(404).json({ error: "No connection link available. Installer state not found." });
    return;
  }
  res.json({ link });
});

router.get("/server-status", requireAuth, (_req, res) => {
  const status = getServerStatus();
  res.json(status);
});

router.post("/xray/restart", requireAuth, (_req, res) => {
  const result = restartXray();
  res.status(result.success ? 200 : 500).json(result);
});

router.get("/installer-state", requireAuth, (_req, res) => {
  const state = readInstallerState();
  res.json(state);
});

router.get("/all-links", requireAuth, (_req, res) => {
  const serverLink = getConnectionLink();

  const db = getDb();
  const deploys = db
    .prepare("SELECT id, platform, project_name, deploy_url, public_path, config_json FROM deployments WHERE status = 'active'")
    .all() as Array<{ id: number; platform: string; project_name: string; deploy_url: string; public_path: string; config_json: string }>;

  const deployLinks = deploys
    .map((d) => {
      let configLink: string | null = null;

      // Always regenerate with full xpadding/alpn params using CLIENT_LINK as template
      if (d.deploy_url) {
        try {
          const host = new URL(d.deploy_url).hostname;
          const label = `${d.platform.charAt(0).toUpperCase() + d.platform.slice(1)}-${d.project_name}`;
          configLink = buildConfigLinkForHost(host, d.public_path || "/api", label);
        } catch {}
      }

      // Fallback to stored config_json if build failed
      if (!configLink) {
        try {
          const cfg = JSON.parse(d.config_json || "{}");
          configLink = cfg.configLink || null;
        } catch {}
      }

      return { id: d.id, platform: d.platform, projectName: d.project_name, url: d.deploy_url, configLink };
    })
    .filter((d) => d.configLink);

  res.json({ serverLink, deployLinks });
});

// Test if a relay URL is reachable
router.get("/check-relay", requireAuth, async (req, res) => {
  const url = req.query.url as string;
  if (!url) {
    res.status(400).json({ error: "url query param required" });
    return;
  }

  const testUrl = url.replace(/\/$/, "") + "/health";
  const start = Date.now();
  try {
    const resp = await fetch(testUrl, { signal: AbortSignal.timeout(10_000) });
    res.json({ ok: resp.status < 500, status: resp.status, ms: Date.now() - start });
  } catch (err) {
    res.json({ ok: false, status: 0, ms: Date.now() - start, error: String(err) });
  }
});

export default router;
