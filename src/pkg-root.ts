import path from "node:path";
import { fileURLToPath } from "node:url";

// Root of the installed package (the directory containing dist/), whether that
// is a global npm install or a git checkout.
export const PKG_ROOT = path.resolve(
  fileURLToPath(new URL("..", import.meta.url))
);

// Resolve a file shipped in templates/ — the one location for assets that must
// reach users, listed in package.json "files" and present in the repo.
export function pkgFile(relative: string): string {
  return path.join(PKG_ROOT, "templates", relative);
}
