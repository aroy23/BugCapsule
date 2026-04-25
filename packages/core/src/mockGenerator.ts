import path from "node:path";

import type { ImportBinding } from "./importGraph.js";
import { relativeImportPath } from "./pathUtils.js";
import type { CapsuleMock } from "./types.js";

export type MockPlan = {
  mocks: CapsuleMock[];
  files: Array<{ relativePath: string; content: string }>;
  rewrites: Map<string, string>;
};

export function createMockPlan(bindings: ImportBinding[]): MockPlan {
  const byModule = new Map<string, ImportBinding[]>();

  for (const binding of bindings) {
    const current = byModule.get(binding.moduleName) ?? [];
    current.push(binding);
    byModule.set(binding.moduleName, current);
  }

  const mocks: CapsuleMock[] = [];
  const files: Array<{ relativePath: string; content: string }> = [];
  const rewrites = new Map<string, string>();

  for (const [moduleName, moduleBindings] of [...byModule.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const mockPath = `__mocks__/${moduleName.replace(/^@/, "").replaceAll("/", "__")}.ts`;
    const namedExports = [...new Set(moduleBindings.flatMap((binding) => binding.namedImports))].sort();

    mocks.push({
      moduleName,
      mode: "auto",
      generatedPath: mockPath,
      reason: "External dependency was outside the capsule slice."
    });
    files.push({
      relativePath: mockPath,
      content: renderMockModule(moduleName, namedExports)
    });
    rewrites.set(moduleName, mockPath);
  }

  return { mocks, files, rewrites };
}

export function rewriteExternalImports(sourceRelativePath: string, content: string, rewrites: Map<string, string>): string {
  let updated = content;

  for (const [moduleName, mockPath] of rewrites) {
    const replacement = relativeImportPath(sourceRelativePath, mockPath);
    updated = updated.replaceAll(`"${moduleName}"`, `"${replacement}"`);
    updated = updated.replaceAll(`'${moduleName}'`, `'${replacement}'`);
  }

  return updated;
}

function renderMockModule(moduleName: string, namedExports: string[]): string {
  const names = namedExports.length > 0 ? namedExports : ["mockedExternal"];
  const exports = names.map((name) => `export function ${name}(..._args: unknown[]): any {\n  return createBugCapsuleMock("${moduleName}.${name}");\n}`).join("\n\n");

  return `const asyncNoop = async () => undefined;\n\nfunction createBugCapsuleMock(label: string): any {\n  return new Proxy(asyncNoop, {\n    get(_target, property) {\n      if (property === "then") {\n        return undefined;\n      }\n\n      return createBugCapsuleMock(\`\${label}.\${String(property)}\`);\n    },\n    apply() {\n      return createBugCapsuleMock(\`\${label}()\`);\n    }\n  });\n}\n\n${exports}\n\nexport default createBugCapsuleMock("${moduleName}.default");\n`;
}

export function mockPathForModule(moduleName: string): string {
  return path.posix.join("__mocks__", `${moduleName.replace(/^@/, "").replaceAll("/", "__")}.ts`);
}
