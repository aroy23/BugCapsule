import fs from "node:fs";
import path from "node:path";
import { Project } from "ts-morph";

import { isTypeScriptLike } from "./fileUtils.js";
import { normalizePath, toRepoRelative } from "./pathUtils.js";

export type ImportBinding = {
  moduleName: string;
  defaultImport?: string;
  namespaceImport?: string;
  namedImports: string[];
};

export type SourceFileNode = {
  path: string;
  imports: string[];
  externalImports: ImportBinding[];
};

export type ImportGraph = {
  nodes: Map<string, SourceFileNode>;
};

export async function buildImportGraph(repoPath: string, entryFiles: string[]): Promise<ImportGraph> {
  const tsconfigPath = path.join(repoPath, "tsconfig.json");
  const project = new Project(fs.existsSync(tsconfigPath)
    ? { tsConfigFilePath: tsconfigPath, skipAddingFilesFromTsConfig: false }
    : { skipAddingFilesFromTsConfig: false });
  const nodes = new Map<string, SourceFileNode>();
  const queue = [...new Set(entryFiles.filter(isTypeScriptLike))];

  for (let index = 0; index < queue.length; index += 1) {
    const relativePath = queue[index];

    if (!relativePath || nodes.has(relativePath)) {
      continue;
    }

    const absolutePath = path.join(repoPath, relativePath);

    if (!fs.existsSync(absolutePath)) {
      continue;
    }

    const sourceFile = project.getSourceFile(absolutePath) ?? project.addSourceFileAtPath(absolutePath);
    const imports: string[] = [];
    const externalImports: ImportBinding[] = [];

    for (const declaration of sourceFile.getImportDeclarations()) {
      const specifier = declaration.getModuleSpecifierValue();
      const resolved = resolveImport(repoPath, relativePath, specifier);

      if (resolved) {
        imports.push(resolved);
        queue.push(resolved);
        continue;
      }

      if (!specifier.startsWith(".")) {
        const binding: ImportBinding = {
          moduleName: specifier,
          namedImports: declaration.getNamedImports().map((namedImport) => namedImport.getName())
        };
        const defaultImport = declaration.getDefaultImport()?.getText();
        const namespaceImport = declaration.getNamespaceImport()?.getText();

        if (defaultImport) {
          binding.defaultImport = defaultImport;
        }

        if (namespaceImport) {
          binding.namespaceImport = namespaceImport;
        }

        externalImports.push(binding);
      }
    }

    for (const declaration of sourceFile.getExportDeclarations()) {
      const specifier = declaration.getModuleSpecifierValue();

      if (!specifier) {
        continue;
      }

      const resolved = resolveImport(repoPath, relativePath, specifier);

      if (resolved) {
        imports.push(resolved);
        queue.push(resolved);
      } else if (!specifier.startsWith(".")) {
        externalImports.push({
          moduleName: specifier,
          namedImports: []
        });
      }
    }

    nodes.set(relativePath, {
      path: relativePath,
      imports: [...new Set(imports)].sort(),
      externalImports
    });
  }

  return { nodes };
}

export function resolveImport(repoPath: string, fromRelativePath: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) {
    return undefined;
  }

  const fromDirectory = path.dirname(path.join(repoPath, fromRelativePath));
  const rawTarget = path.resolve(fromDirectory, specifier);
  const candidates = candidatePaths(rawTarget);
  const found = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());

  return found ? normalizePath(toRepoRelative(repoPath, found)) : undefined;
}

function candidatePaths(rawTarget: string): string[] {
  const withoutJsExtension = rawTarget.replace(/\.[cm]?js$/, "");

  return [
    rawTarget,
    withoutJsExtension,
    `${withoutJsExtension}.ts`,
    `${withoutJsExtension}.tsx`,
    `${withoutJsExtension}.mts`,
    `${withoutJsExtension}.cts`,
    path.join(withoutJsExtension, "index.ts"),
    path.join(withoutJsExtension, "index.tsx")
  ];
}
