import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Directory that holds panel.db and generated secrets. */
export function dataDir(): string {
  if (process.env.DB_PATH) return dirname(resolve(process.env.DB_PATH));
  return resolve(__dirname, "../../data");
}
