import { Router } from "express";
import type { Request } from "express";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import bcrypt from "bcrypt";
import { getDb } from "../db/init.js";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../utils/jwt.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../utils/helpers.js";
import { dataDir } from "../utils/paths.js";
import { bumpSessionVersion, getSessionVersion } from "../utils/session.js";

const router = Router();

const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILURES = 8;
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

function clientIp(req: Request): string {
  const peer = req.socket.remoteAddress ?? "";
  const loopback = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
  if (loopback) {
    const real = req.headers["x-real-ip"];
    if (typeof real === "string" && real.trim()) return real.trim().slice(0, 64);
  }
  return peer || "unknown";
}

function loginLimited(ip: string): boolean {
  const row = loginAttempts.get(ip);
  if (!row) return false;
  if (row.resetAt <= Date.now()) {
    loginAttempts.delete(ip);
    return false;
  }
  return row.count >= LOGIN_MAX_FAILURES;
}

function noteLoginFailure(ip: string) {
  const now = Date.now();
  const row = loginAttempts.get(ip);
  if (!row || row.resetAt <= now) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return;
  }
  row.count += 1;
}

router.post(
  "/login",
  asyncHandler(async (req, res) => {
    const ip = clientIp(req);
    if (loginLimited(ip)) {
      res.status(429).json({ error: "Too many login attempts" });
      return;
    }

    const { username, password } = req.body;
    if (!username || !password) {
      res.status(400).json({ error: "Username and password are required" });
      return;
    }

    const db = getDb();
    const admin = db.prepare("SELECT * FROM admin WHERE username = ?").get(username) as
      | { id: number; username: string; password: string }
      | undefined;

    if (!admin || !(await bcrypt.compare(password, admin.password))) {
      noteLoginFailure(ip);
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    loginAttempts.delete(ip);
    const stamp = join(dataDir(), "initial-admin-password");
    if (existsSync(stamp)) unlinkSync(stamp);

    db.prepare("INSERT INTO activity_log (action, detail) VALUES (?, ?)").run(
      "login",
      `Admin login: ${username}`
    );

    const payload = { userId: admin.id, username: admin.username, sv: getSessionVersion() };
    res.json({
      accessToken: signAccessToken(payload),
      refreshToken: signRefreshToken(payload),
    });
  })
);

router.post(
  "/refresh",
  asyncHandler(async (req, res) => {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      res.status(400).json({ error: "Refresh token is required" });
      return;
    }

    try {
      const payload = verifyRefreshToken(refreshToken);
      if (payload.sv !== getSessionVersion()) {
        res.status(401).json({ error: "Invalid or expired refresh token" });
        return;
      }
      const newPayload = { userId: payload.userId, username: payload.username, sv: payload.sv };
      res.json({
        accessToken: signAccessToken(newPayload),
        refreshToken: signRefreshToken(newPayload),
      });
    } catch {
      res.status(401).json({ error: "Invalid or expired refresh token" });
    }
  })
);

router.get("/me", requireAuth, (req, res) => {
  res.json({ userId: req.user!.userId, username: req.user!.username });
});

router.post(
  "/change-password",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      res.status(400).json({ error: "Current and new passwords are required" });
      return;
    }
    if (newPassword.length < 6) {
      res.status(400).json({ error: "New password must be at least 6 characters" });
      return;
    }

    const db = getDb();
    const admin = db.prepare("SELECT * FROM admin WHERE id = ?").get(req.user!.userId) as
      | { id: number; password: string }
      | undefined;

    if (!admin || !(await bcrypt.compare(currentPassword, admin.password))) {
      res.status(401).json({ error: "Current password is incorrect" });
      return;
    }

    const hashed = await bcrypt.hash(newPassword, 10);
    db.prepare("UPDATE admin SET password = ? WHERE id = ?").run(hashed, admin.id);
    bumpSessionVersion();

    db.prepare("INSERT INTO activity_log (action, detail) VALUES (?, ?)").run(
      "change_password",
      "Admin password changed"
    );

    res.json({ message: "Password changed successfully" });
  })
);

export default router;
