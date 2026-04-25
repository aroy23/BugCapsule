import fs from "node:fs";
import path from "node:path";
import { Node, Project, SyntaxKind, type CallExpression, type Expression, type SourceFile } from "ts-morph";

import { isTypeScriptLike, listProjectFiles } from "./fileUtils.js";
import { resolveImport } from "./importGraph.js";
import { normalizePath } from "./pathUtils.js";
import type { StackFrame, SuspectedUpstreamCause } from "./types.js";

type StackTarget = {
  file: string;
  names: Set<string>;
  frameIndex: number;
  line?: number;
};

type ImportedLocal = {
  localName: string;
  importedName: string;
  modulePath: string;
  namespace: boolean;
};

type HelperCall = {
  name: string;
  modulePath: string;
};

type Transformation = {
  description: string;
  helperCalls: HelperCall[];
};

type CandidateRecord = {
  path: string;
  score: number;
  reasons: Set<string>;
};

const MAX_REASON_LENGTH = 220;

export async function findUpstreamCandidates(options: {
  repoPath: string;
  stackTrace: StackFrame[];
  maxCandidates?: number;
}): Promise<SuspectedUpstreamCause[]> {
  if (options.stackTrace.length === 0) {
    return [];
  }

  const project = createProject(options.repoPath);
  const sourceFiles = await loadProjectSourceFiles(project, options.repoPath);
  const targets = buildStackTargets(sourceFiles, options.stackTrace);

  if (targets.length === 0) {
    return [];
  }

  const candidates = new Map<string, CandidateRecord>();

  for (const [relativePath, sourceFile] of sourceFiles) {
    const imports = collectImports(options.repoPath, relativePath, sourceFile);

    for (const target of targets) {
      const targetImports = imports.filter((item) =>
        item.modulePath === target.file &&
        (item.namespace || target.names.has(item.importedName) || item.importedName === "default")
      );

      if (targetImports.length === 0) {
        continue;
      }

      for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const imported = importForCall(call, targetImports);

        if (!imported) {
          continue;
        }

        const firstArg = call.getArguments()[0] as Expression | undefined;

        if (!firstArg) {
          continue;
        }

        const transformation = describeTransformation(firstArg, sourceFile, imports, new Set<string>());

        if (!transformation) {
          continue;
        }

        const targetName = imported.namespace ? `${imported.localName}.${callName(call)}` : imported.importedName;
        const line = call.getStartLineNumber();
        addCandidate(
          candidates,
          relativePath,
          `Calls ${targetName} from stack frame ${target.frameIndex + 1} and passes ${transformation.description} at line ${line}.`,
          4
        );

        for (const helper of transformation.helperCalls) {
          const helperSummary = summarizeHelperTransformation(sourceFiles.get(helper.modulePath), helper.name);
          const reason = helperSummary
            ? `${relativePath} passes the result of ${helper.name} into ${targetName}; ${helperSummary}.`
            : `${relativePath} passes the result of ${helper.name} into ${targetName}.`;
          addCandidate(candidates, helper.modulePath, reason, helperSummary ? 9 : 6);
        }
      }
    }
  }

  return [...candidates.values()]
    .map((candidate) => ({
      path: candidate.path,
      reason: trimReason([...candidate.reasons].join(" "))
    }))
    .sort((left, right) => {
      const leftScore = candidates.get(left.path)?.score ?? 0;
      const rightScore = candidates.get(right.path)?.score ?? 0;
      return rightScore - leftScore || left.path.localeCompare(right.path);
    })
    .slice(0, options.maxCandidates ?? 8);
}

function createProject(repoPath: string): Project {
  const tsconfigPath = path.join(repoPath, "tsconfig.json");
  return new Project(fs.existsSync(tsconfigPath)
    ? { tsConfigFilePath: tsconfigPath, skipAddingFilesFromTsConfig: false }
    : { skipAddingFilesFromTsConfig: false });
}

async function loadProjectSourceFiles(project: Project, repoPath: string): Promise<Map<string, SourceFile>> {
  const files = await listProjectFiles(repoPath);
  const sourceFiles = new Map<string, SourceFile>();

  for (const file of files.filter(isTypeScriptLike)) {
    const absolutePath = path.join(repoPath, file);
    const sourceFile = project.getSourceFile(absolutePath) ?? project.addSourceFileAtPathIfExists(absolutePath);

    if (sourceFile) {
      sourceFiles.set(normalizePath(file), sourceFile);
    }
  }

  return sourceFiles;
}

function buildStackTargets(sourceFiles: Map<string, SourceFile>, stackTrace: StackFrame[]): StackTarget[] {
  const targets: StackTarget[] = [];

  for (const [index, frame] of stackTrace.entries()) {
    const sourceFile = sourceFiles.get(frame.file);

    if (!sourceFile) {
      continue;
    }

    const names = exportedNamesForFrame(sourceFile, frame.functionName);

    if (names.size === 0) {
      continue;
    }

    targets.push({
      file: frame.file,
      names,
      frameIndex: index,
      ...(frame.line ? { line: frame.line } : {})
    });
  }

  return targets;
}

function exportedNamesForFrame(sourceFile: SourceFile, functionName: string | undefined): Set<string> {
  const exportedNames = [...sourceFile.getExportedDeclarations().keys()]
    .filter((name) => name !== "default");

  if (exportedNames.length === 0) {
    return new Set();
  }

  const normalizedFrameName = normalizeFunctionName(functionName);

  if (!normalizedFrameName) {
    return new Set(exportedNames);
  }

  const matching = exportedNames.filter((name) =>
    name === normalizedFrameName ||
    name.includes(normalizedFrameName) ||
    normalizedFrameName.includes(name)
  );

  return new Set(matching.length > 0 ? matching : exportedNames);
}

function collectImports(repoPath: string, relativePath: string, sourceFile: SourceFile): ImportedLocal[] {
  const imports: ImportedLocal[] = [];

  for (const declaration of sourceFile.getImportDeclarations()) {
    const modulePath = resolveImport(repoPath, relativePath, declaration.getModuleSpecifierValue());

    if (!modulePath) {
      continue;
    }

    const defaultImport = declaration.getDefaultImport();

    if (defaultImport) {
      imports.push({
        localName: defaultImport.getText(),
        importedName: "default",
        modulePath,
        namespace: false
      });
    }

    const namespaceImport = declaration.getNamespaceImport();

    if (namespaceImport) {
      imports.push({
        localName: namespaceImport.getText(),
        importedName: "*",
        modulePath,
        namespace: true
      });
    }

    for (const named of declaration.getNamedImports()) {
      const importedName = named.getName();
      const alias = named.getAliasNode()?.getText();
      imports.push({
        localName: alias ?? importedName,
        importedName,
        modulePath,
        namespace: false
      });
    }
  }

  return imports;
}

function importForCall(call: CallExpression, imports: ImportedLocal[]): ImportedLocal | undefined {
  const expression = call.getExpression();

  if (Node.isIdentifier(expression)) {
    return imports.find((item) => !item.namespace && item.localName === expression.getText());
  }

  if (Node.isPropertyAccessExpression(expression)) {
    const qualifier = expression.getExpression().getText();
    const property = expression.getName();
    return imports.find((item) =>
      item.namespace &&
      item.localName === qualifier &&
      (item.importedName === "*" || item.importedName === property)
    );
  }

  return undefined;
}

function describeTransformation(
  expression: Expression,
  sourceFile: SourceFile,
  imports: ImportedLocal[],
  seenIdentifiers: Set<string>
): Transformation | undefined {
  const unwrapped = unwrapExpression(expression);

  if (Node.isIdentifier(unwrapped)) {
    const name = unwrapped.getText();

    if (seenIdentifiers.has(name)) {
      return undefined;
    }

    seenIdentifiers.add(name);
    const initializer = findIdentifierInitializer(unwrapped);

    if (!initializer) {
      return undefined;
    }

    const nested = describeTransformation(initializer, sourceFile, imports, seenIdentifiers);

    if (!nested) {
      return undefined;
    }

    return {
      description: `${name} derived from ${nested.description}`,
      helperCalls: nested.helperCalls
    };
  }

  if (Node.isCallExpression(unwrapped)) {
    const helper = helperCallFor(unwrapped, imports);
    return {
      description: `the result of ${callName(unwrapped)}`,
      helperCalls: helper ? [helper] : []
    };
  }

  if (Node.isObjectLiteralExpression(unwrapped)) {
    return {
      description: hasObjectSpread(unwrapped) ? "an object literal with spread fields" : "an object literal",
      helperCalls: []
    };
  }

  if (Node.isArrayLiteralExpression(unwrapped)) {
    return {
      description: "an array literal",
      helperCalls: []
    };
  }

  if (Node.isConditionalExpression(unwrapped)) {
    return {
      description: "a conditional expression",
      helperCalls: helperCallsInside(unwrapped, imports)
    };
  }

  if (Node.isBinaryExpression(unwrapped)) {
    return {
      description: binaryDescription(unwrapped),
      helperCalls: helperCallsInside(unwrapped, imports)
    };
  }

  return undefined;
}

function unwrapExpression(expression: Expression): Expression {
  let current = expression;

  while (
    Node.isParenthesizedExpression(current) ||
    Node.isAsExpression(current) ||
    Node.isTypeAssertion(current) ||
    Node.isSatisfiesExpression(current) ||
    Node.isNonNullExpression(current) ||
    Node.isAwaitExpression(current)
  ) {
    current = current.getExpression();
  }

  return current;
}

function findIdentifierInitializer(identifier: import("ts-morph").Identifier): Expression | undefined {
  for (const definition of identifier.getDefinitions()) {
    const node = definition.getDeclarationNode();

    if (Node.isVariableDeclaration(node)) {
      return node.getInitializer();
    }
  }

  return undefined;
}

function helperCallFor(call: CallExpression, imports: ImportedLocal[]): HelperCall | undefined {
  const expression = call.getExpression();

  if (Node.isIdentifier(expression)) {
    const imported = imports.find((item) => !item.namespace && item.localName === expression.getText());
    return imported ? { name: imported.importedName, modulePath: imported.modulePath } : undefined;
  }

  if (Node.isPropertyAccessExpression(expression)) {
    const qualifier = expression.getExpression().getText();
    const property = expression.getName();
    const imported = imports.find((item) => item.namespace && item.localName === qualifier);
    return imported ? { name: property, modulePath: imported.modulePath } : undefined;
  }

  return undefined;
}

function helperCallsInside(expression: Expression, imports: ImportedLocal[]): HelperCall[] {
  const helpers = new Map<string, HelperCall>();

  for (const call of expression.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const helper = helperCallFor(call, imports);

    if (helper) {
      helpers.set(`${helper.modulePath}:${helper.name}`, helper);
    }
  }

  return [...helpers.values()];
}

function summarizeHelperTransformation(sourceFile: SourceFile | undefined, helperName: string): string | undefined {
  if (!sourceFile) {
    return undefined;
  }

  const declarations = sourceFile.getExportedDeclarations().get(helperName) ?? [];
  const searchRoots = declarations.length > 0 ? declarations : [sourceFile];

  for (const root of searchRoots) {
    const suspicious = firstSuspiciousTransformation(root);

    if (suspicious) {
      return suspicious;
    }
  }

  return undefined;
}

function firstSuspiciousTransformation(root: Node): string | undefined {
  for (const binary of root.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    if (binary.getOperatorToken().getKind() === SyntaxKind.QuestionQuestionToken) {
      return `rewrites missing/nullish values via \`${trimCode(binary.getText())}\` at line ${binary.getStartLineNumber()}`;
    }
  }

  for (const conditional of root.getDescendantsOfKind(SyntaxKind.ConditionalExpression)) {
    return `branches while constructing input via \`${trimCode(conditional.getText())}\` at line ${conditional.getStartLineNumber()}`;
  }

  for (const objectLiteral of root.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)) {
    if (hasObjectSpread(objectLiteral)) {
      return `reconstructs input with object spreads at line ${objectLiteral.getStartLineNumber()}`;
    }
  }

  return undefined;
}

function hasObjectSpread(objectLiteral: import("ts-morph").ObjectLiteralExpression): boolean {
  return objectLiteral.getProperties().some((property) => Node.isSpreadAssignment(property));
}

function binaryDescription(expression: import("ts-morph").BinaryExpression): string {
  const operator = expression.getOperatorToken().getKind();

  if (operator === SyntaxKind.QuestionQuestionToken) {
    return "a nullish-coalescing expression";
  }

  if (operator === SyntaxKind.BarBarToken) {
    return "a fallback expression";
  }

  return "a binary expression";
}

function callName(call: CallExpression): string {
  const expression = call.getExpression();

  if (Node.isPropertyAccessExpression(expression)) {
    return expression.getName();
  }

  return expression.getText();
}

function addCandidate(candidates: Map<string, CandidateRecord>, filePath: string, reason: string, score: number): void {
  const current = candidates.get(filePath) ?? {
    path: filePath,
    score: 0,
    reasons: new Set<string>()
  };

  current.score += score;
  current.reasons.add(trimReason(reason));
  candidates.set(filePath, current);
}

function trimReason(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > MAX_REASON_LENGTH
    ? `${normalized.slice(0, MAX_REASON_LENGTH - 1).trimEnd()}...`
    : normalized;
}

function trimCode(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeFunctionName(functionName: string | undefined): string | undefined {
  if (!functionName) {
    return undefined;
  }

  return functionName
    .replace(/^async\s+/, "")
    .split(".")
    .at(-1)
    ?.replace(/[^\w$].*$/, "");
}
