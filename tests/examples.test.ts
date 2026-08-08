import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const examplesDir = join(process.cwd(), "examples");

const expectedExamples = [
  "basic-store-and-recall.ts",
  "relationship-graph.ts",
  "custom-config.ts",
  "standalone-mcp-server.ts",
  "programmatic-api.ts",
] as const;

describe("examples directory", () => {
  it("contains exactly the 5 expected example files", () => {
    const files = readdirSync(examplesDir)
      .filter((f) => f.endsWith(".ts"))
      .sort();
    expect(files).toEqual([...expectedExamples].sort());
  });

  it.each([...expectedExamples])("example %s exists", (name) => {
    const files = readdirSync(examplesDir);
    expect(files).toContain(name);
  });
});

describe("examples parse as valid TypeScript", () => {
  // We don't execute the examples (they create local SQLite files); we verify
  // each one parses and type-checks by transpiling it through the TypeScript
  // compiler. A SyntaxError or unresolvable type error fails the test.
  it.each([...expectedExamples])("parses: %s", (name) => {
    const filePath = join(examplesDir, name);
    const source = readFileSync(filePath, "utf-8");

    // transpileModule catches syntax errors and reports them via diagnostics.
    const result = ts.transpileModule(source, {
      fileName: filePath,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        strict: true,
       isolatedModules: true,
      },
      reportDiagnostics: true,
    });

    const diagnostics = result.diagnostics ?? [];
    const errors = diagnostics.filter(
      (d) => d.category === ts.DiagnosticCategory.Error,
    );
    expect(errors).toEqual([]);
  });
});
