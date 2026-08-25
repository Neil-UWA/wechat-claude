import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Root of the installed package (the directory containing dist/), whether that
// is a global npm install or a git checkout.
export const PKG_ROOT = path.resolve(
  fileURLToPath(new URL("..", import.meta.url))
);

// Resolve a file shipped in templates/. Falls back to the repo-local copy so a
// git checkout keeps working if templates/ was not built/copied.
export function pkgFile(relative: string): string {
  const primary = path.join(PKG_ROOT, "templates", relative);
  if (fs.existsSync(primary)) return primary;
  return path.join(PKG_ROOT, relative);
}
