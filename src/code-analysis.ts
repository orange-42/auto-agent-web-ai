import * as ts from "typescript";

export interface CodeDiagnostic {
  line: number;
  column: number;
  message: string;
}

export interface CodeAnalysisResult {
  diagnostics: CodeDiagnostic[];
  hasDefaultExport: boolean;
  namedExports: string[];
  importSpecifiers: string[];
  functionNames: string[];
  language: "js" | "ts" | "vue-js" | "vue-ts" | "unknown";
}

interface ExtractedScript {
  code: string;
  offsetLine: number;
  language: CodeAnalysisResult["language"];
  scriptKind: ts.ScriptKind;
}

function getLineAndCharacter(sourceFile: ts.SourceFile, start: number) {
  const pos = sourceFile.getLineAndCharacterOfPosition(start);
  return {
    line: pos.line + 1,
    column: pos.character + 1,
  };
}

function flattenMessage(messageText: string | ts.DiagnosticMessageChain): string {
  if (typeof messageText === "string") return messageText;
  const parts: string[] = [];
  let current: ts.DiagnosticMessageChain | undefined = messageText;
  while (current) {
    parts.push(current.messageText);
    current = current.next?.[0];
  }
  return parts.join(" ");
}

function extractVueScript(content: string): ExtractedScript | null {
  const match = content.match(/<script\b([^>]*)>([\s\S]*?)<\/script>/i);
  if (!match) return null;

  const attrs = match[1] || "";
  const code = match[2] || "";
  const before = content.slice(0, match.index || 0);
  const offsetLine = before.split(/\r?\n/).length;
  const isTs = /\blang\s*=\s*["']ts["']/i.test(attrs);

  return {
    code,
    offsetLine,
    language: isTs ? "vue-ts" : "vue-js",
    scriptKind: isTs ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  };
}

function extractScriptForAnalysis(filePath: string, content: string): ExtractedScript {
  if (filePath.endsWith(".vue")) {
    return (
      extractVueScript(content) || {
        code: "",
        offsetLine: 0,
        language: "unknown",
        scriptKind: ts.ScriptKind.JS,
      }
    );
  }

  if (filePath.endsWith(".ts") || filePath.endsWith(".tsx")) {
    return {
      code: content,
      offsetLine: 0,
      language: "ts",
      scriptKind: filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    };
  }

  if (filePath.endsWith(".js") || filePath.endsWith(".jsx")) {
    return {
      code: content,
      offsetLine: 0,
      language: "js",
      scriptKind: filePath.endsWith(".jsx") ? ts.ScriptKind.JSX : ts.ScriptKind.JS,
    };
  }

  return {
    code: content,
    offsetLine: 0,
    language: "unknown",
    scriptKind: ts.ScriptKind.Unknown,
  };
}

export function analyzeCodeFile(filePath: string, content: string): CodeAnalysisResult {
  const extracted = extractScriptForAnalysis(filePath, content);
  if (!extracted.code.trim()) {
    return {
      diagnostics: [],
      hasDefaultExport: false,
      namedExports: [],
      importSpecifiers: [],
      functionNames: [],
      language: extracted.language,
    };
  }

  const analysisFilePath = filePath.endsWith(".vue") ? `${filePath}.${extracted.scriptKind === ts.ScriptKind.TS ? "ts" : "js"}` : filePath;
  const sourceFile = ts.createSourceFile(
    analysisFilePath,
    extracted.code,
    ts.ScriptTarget.Latest,
    true,
    extracted.scriptKind,
  );

  const transpileResult = ts.transpileModule(extracted.code, {
    fileName: analysisFilePath,
    reportDiagnostics: true,
    compilerOptions: {
      allowJs: true,
      checkJs: true,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.Preserve,
    },
  });

  const diagnostics = (transpileResult.diagnostics || []).map((diag: ts.Diagnostic) => {
    const start = typeof diag.start === "number" ? diag.start : 0;
    const pos = getLineAndCharacter(sourceFile, start);
    return {
      line: pos.line + extracted.offsetLine,
      column: pos.column,
      message: flattenMessage(diag.messageText),
    };
  });

  const namedExports = new Set<string>();
  const importSpecifiers = new Set<string>();
  const functionNames = new Set<string>();
  let hasDefaultExport = false;

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      importSpecifiers.add(node.moduleSpecifier.text);
    }

    if (ts.isFunctionDeclaration(node) && node.name?.text) {
      functionNames.add(node.name.text);
    }

    if (ts.isExportAssignment(node)) {
      hasDefaultExport = true;
    }

    const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    const hasExport = !!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    const hasDefault = !!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);

    if (hasExport && hasDefault) {
      hasDefaultExport = true;
    }

    if (hasExport) {
      if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node)) && node.name?.text) {
        namedExports.add(node.name.text);
      }
      if (ts.isVariableStatement(node)) {
        node.declarationList.declarations.forEach((decl) => {
          if (ts.isIdentifier(decl.name)) namedExports.add(decl.name.text);
        });
      }
    }

    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      node.exportClause.elements.forEach((element) => namedExports.add(element.name.text));
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  return {
    diagnostics,
    hasDefaultExport,
    namedExports: Array.from(namedExports),
    importSpecifiers: Array.from(importSpecifiers),
    functionNames: Array.from(functionNames),
    language: extracted.language,
  };
}
