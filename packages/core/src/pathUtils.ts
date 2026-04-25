import path from "node:path";

export function normalizePath(value: string): string {
  return value.split(path.sep).join("/");
}

export function toAbsolutePath(rootPath: string, maybeRelative: string): string {
  return path.isAbsolute(maybeRelative) ? path.normalize(maybeRelative) : path.resolve(rootPath, maybeRelative);
}

export function toRepoRelative(rootPath: string, absolutePath: string): string {
  return normalizePath(path.relative(rootPath, absolutePath));
}

export function assertInsideRoot(rootPath: string, targetPath: string): void {
  const root = path.resolve(rootPath);
  const target = path.resolve(targetPath);
  const relative = path.relative(root, target);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes repository root: ${targetPath}`);
  }
}

export function relativeImportPath(fromFile: string, toFile: string): string {
  const fromDirectory = path.dirname(fromFile);
  let relative = normalizePath(path.relative(fromDirectory, toFile));

  if (!relative.startsWith(".")) {
    relative = `./${relative}`;
  }

  return relative.replace(/\.[cm]?tsx?$/, ".js");
}

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);

  return slug || "capsule";
}
