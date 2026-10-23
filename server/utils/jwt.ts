import jwt from "jsonwebtoken";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDir } from "./paths.js";

const WEAK_SECRETS = new Set([
  "dev-access-secret",
  "dev-refresh-secret",
  "change-me",
  "change-me-to-a-random-secret",
  "change-me-to-another-random-secret",
]);

const ACCESS_EXPIRY = "15m";
const REFRESH_EXPIRY = "7d";

export interface TokenPayload {
  userId: number;
  username: string;
  sv: number;
}

function loadSecret(envName: string, fileName: string): string {
  const fromEnv = process.env[envName]?.trim() ?? "";
  if (fromEnv.length >= 32 && !WEAK_SECRETS.has(fromEnv)) return fromEnv;

  const path = join(dataDir(), fileName);
  if (existsSync(path)) {
    const stored = readFileSync(path, "utf-8").trim();
    if (stored.length >= 32 && !WEAK_SECRETS.has(stored)) return stored;
  }

  const generated = randomBytes(32).toString("hex");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, generated + "\n", { mode: 0o600 });
  return generated;
}

const ACCESS_SECRET = loadSecret("JWT_SECRET", ".jwt-access");
const REFRESH_SECRET = loadSecret("JWT_REFRESH_SECRET", ".jwt-refresh");

export function signAccessToken(payload: TokenPayload): string {
  return jwt.sign(
    { userId: payload.userId, username: payload.username, sv: payload.sv },
    ACCESS_SECRET,
    { expiresIn: ACCESS_EXPIRY }
  );
}

export function signRefreshToken(payload: TokenPayload): string {
  return jwt.sign(
    { userId: payload.userId, username: payload.username, sv: payload.sv },
    REFRESH_SECRET,
    { expiresIn: REFRESH_EXPIRY }
  );
}

export function verifyAccessToken(token: string): TokenPayload {
  const decoded = jwt.verify(token, ACCESS_SECRET) as TokenPayload;
  return { userId: decoded.userId, username: decoded.username, sv: Number(decoded.sv) };
}

export function verifyRefreshToken(token: string): TokenPayload {
  const decoded = jwt.verify(token, REFRESH_SECRET) as TokenPayload;
  return { userId: decoded.userId, username: decoded.username, sv: Number(decoded.sv) };
}
