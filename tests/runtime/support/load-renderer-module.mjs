import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

/** Compile actual portable renderer helpers into a temporary ESM graph for node:test. */
export async function loadRendererModule(sourceFile, t) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-renderer-module-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const files = new Map();
  function compile(sourcePath) {
    const absolute = path.resolve(sourcePath);
    if (files.has(absolute)) return files.get(absolute);
    const destination = path.join(tempRoot, `${files.size}.mjs`);
    files.set(absolute, destination);
    const source = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2023, verbatimModuleSyntax: true, jsx: ts.JsxEmit.ReactJSX },
      fileName: absolute,
    }).outputText;
    const output = source.replace(/(from\s*['"]|import\s*['"])([^'"]+)(['"])/g, (match, prefix, specifier, suffix) => {
      let target;
      if (specifier.startsWith('@/')) target = path.resolve('src', specifier.slice(2));
      else if (specifier.startsWith('@shared/')) target = path.resolve('shared', specifier.slice(8));
      else if (specifier.startsWith('.')) target = path.resolve(path.dirname(absolute), specifier);
      else return `${prefix}${import.meta.resolve(specifier)}${suffix}`;
      const candidates = [target, target.replace(/\.js$/, '.ts'), `${target}.ts`, `${target}.tsx`];
      const file = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
      if (!file) throw new Error(`Cannot resolve ${specifier} from ${absolute}`);
      return `${prefix}${pathToFileURL(compile(file)).href}${suffix}`;
    });
    fs.writeFileSync(destination, output);
    return destination;
  }
  return import(pathToFileURL(compile(sourceFile)).href);
}
