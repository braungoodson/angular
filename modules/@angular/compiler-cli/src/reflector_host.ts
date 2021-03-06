/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {AngularCompilerOptions, MetadataCollector, ModuleMetadata} from '@angular/tsc-wrapped';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

import {AssetUrl, ImportGenerator} from './compiler_private';
import {StaticReflectorHost, StaticSymbol} from './static_reflector';

const EXT = /(\.ts|\.d\.ts|\.js|\.jsx|\.tsx)$/;
const DTS = /\.d\.ts$/;

export interface ReflectorHostContext {
  fileExists(fileName: string): boolean;
  directoryExists(directoryName: string): boolean;
  readFile(fileName: string): string;
  assumeFileExists(fileName: string): void;
}

export class ReflectorHost implements StaticReflectorHost, ImportGenerator {
  private metadataCollector = new MetadataCollector();
  private context: ReflectorHostContext;
  constructor(
      private program: ts.Program, private compilerHost: ts.CompilerHost,
      private options: AngularCompilerOptions, context?: ReflectorHostContext) {
    this.context = context || new NodeReflectorHostContext();
  }

  angularImportLocations() {
    return {
      coreDecorators: '@angular/core/src/metadata',
      diDecorators: '@angular/core/src/di/decorators',
      diMetadata: '@angular/core/src/di/metadata',
      diOpaqueToken: '@angular/core/src/di/opaque_token',
      animationMetadata: '@angular/core/src/animation/metadata',
      provider: '@angular/core/src/di/provider'
    };
  }

  private resolve(m: string, containingFile: string) {
    const resolved =
        ts.resolveModuleName(m, containingFile, this.options, this.context).resolvedModule;
    return resolved ? resolved.resolvedFileName : null;
  };

  private normalizeAssetUrl(url: string): string {
    let assetUrl = AssetUrl.parse(url);
    return assetUrl ? `${assetUrl.packageName}/${assetUrl.modulePath}` : null;
  }

  private resolveAssetUrl(url: string, containingFile: string): string {
    let assetUrl = this.normalizeAssetUrl(url);
    if (assetUrl) {
      return this.resolve(assetUrl, containingFile);
    }
    return url;
  }

  /**
   * We want a moduleId that will appear in import statements in the generated code.
   * These need to be in a form that system.js can load, so absolute file paths don't work.
   * Relativize the paths by checking candidate prefixes of the absolute path, to see if
   * they are resolvable by the moduleResolution strategy from the CompilerHost.
   */
  getImportPath(containingFile: string, importedFile: string) {
    importedFile = this.resolveAssetUrl(importedFile, containingFile);
    containingFile = this.resolveAssetUrl(containingFile, '');

    // If a file does not yet exist (because we compile it later), we still need to
    // assume it exists it so that the `resolve` method works!
    if (!this.compilerHost.fileExists(importedFile)) {
      this.context.assumeFileExists(importedFile);
    }

    const importModuleName = importedFile.replace(EXT, '');
    const parts = importModuleName.split(path.sep).filter(p => !!p);

    for (let index = parts.length - 1; index >= 0; index--) {
      let candidate = parts.slice(index, parts.length).join(path.sep);
      if (this.resolve('.' + path.sep + candidate, containingFile) === importedFile) {
        return `./${candidate}`;
      }
      if (this.resolve(candidate, containingFile) === importedFile) {
        return candidate;
      }
    }

    // Try a relative import
    let candidate = path.relative(path.dirname(containingFile), importModuleName);
    if (this.resolve(candidate, containingFile) === importedFile) {
      return candidate;
    }

    throw new Error(
        `Unable to find any resolvable import for ${importedFile} relative to ${containingFile}`);
  }

  findDeclaration(
      module: string, symbolName: string, containingFile: string,
      containingModule?: string): StaticSymbol {
    if (!containingFile || !containingFile.length) {
      if (module.indexOf('.') === 0) {
        throw new Error('Resolution of relative paths requires a containing file.');
      }
      // Any containing file gives the same result for absolute imports
      containingFile = path.join(this.options.basePath, 'index.ts');
    }

    try {
      let assetUrl = this.normalizeAssetUrl(module);
      if (assetUrl) {
        module = assetUrl;
      }
      const filePath = this.resolve(module, containingFile);

      if (!filePath) {
        // If the file cannot be found the module is probably referencing a declared module
        // for which there is no disambiguating file and we also don't need to track
        // re-exports. Just use the module name.
        return this.getStaticSymbol(module, symbolName);
      }

      const tc = this.program.getTypeChecker();
      const sf = this.program.getSourceFile(filePath);
      if (!sf || !(<any>sf).symbol) {
        // The source file was not needed in the compile but we do need the values from
        // the corresponding .ts files stored in the .metadata.json file. Check the file
        // for exports to see if the file is exported.
        return this.resolveExportedSymbol(filePath, symbolName) ||
            this.getStaticSymbol(filePath, symbolName);
      }

      let symbol = tc.getExportsOfModule((<any>sf).symbol).find(m => m.name === symbolName);
      if (!symbol) {
        throw new Error(`can't find symbol ${symbolName} exported from module ${filePath}`);
      }
      if (symbol &&
          symbol.flags & ts.SymbolFlags.Alias) {  // This is an alias, follow what it aliases
        symbol = tc.getAliasedSymbol(symbol);
      }
      const declaration = symbol.getDeclarations()[0];
      const declarationFile = declaration.getSourceFile().fileName;

      return this.getStaticSymbol(declarationFile, symbol.getName());
    } catch (e) {
      console.error(`can't resolve module ${module} from ${containingFile}`);
      throw e;
    }
  }

  private typeCache = new Map<string, StaticSymbol>();
  private resolverCache = new Map<string, ModuleMetadata>();

  /**
   * getStaticSymbol produces a Type whose metadata is known but whose implementation is not loaded.
   * All types passed to the StaticResolver should be pseudo-types returned by this method.
   *
   * @param declarationFile the absolute path of the file where the symbol is declared
   * @param name the name of the type.
   */
  getStaticSymbol(declarationFile: string, name: string): StaticSymbol {
    let key = `"${declarationFile}".${name}`;
    let result = this.typeCache.get(key);
    if (!result) {
      result = new StaticSymbol(declarationFile, name);
      this.typeCache.set(key, result);
    }
    return result;
  }

  getMetadataFor(filePath: string): ModuleMetadata {
    if (!this.context.fileExists(filePath)) {
      // If the file doesn't exists then we cannot return metadata for the file.
      // This will occur if the user refernced a declared module for which no file
      // exists for the module (i.e. jQuery or angularjs).
      return;
    }
    if (DTS.test(filePath)) {
      const metadataPath = filePath.replace(DTS, '.metadata.json');
      if (this.context.fileExists(metadataPath)) {
        return this.readMetadata(metadataPath);
      }
    } else {
      const sf = this.program.getSourceFile(filePath);
      if (!sf) {
        throw new Error(`Source file ${filePath} not present in program.`);
      }
      return this.metadataCollector.getMetadata(sf);
    }
  }

  readMetadata(filePath: string) {
    try {
      return this.resolverCache.get(filePath) || JSON.parse(this.context.readFile(filePath));
    } catch (e) {
      console.error(`Failed to read JSON file ${filePath}`);
      throw e;
    }
  }

  private getResolverMetadata(filePath: string): ModuleMetadata {
    let metadata = this.resolverCache.get(filePath);
    if (!metadata) {
      metadata = this.getMetadataFor(filePath);
      this.resolverCache.set(filePath, metadata);
    }
    return metadata;
  }

  private resolveExportedSymbol(filePath: string, symbolName: string): StaticSymbol {
    const resolveModule = (moduleName: string): string => {
      const resolvedModulePath = this.resolve(moduleName, filePath);
      if (!resolvedModulePath) {
        throw new Error(`Could not resolve module '${moduleName}' relative to file ${filePath}`);
      }
      return resolvedModulePath;
    };
    let metadata = this.getResolverMetadata(filePath);
    if (metadata) {
      // If we have metadata for the symbol, this is the original exporting location.
      if (metadata.metadata[symbolName]) {
        return this.getStaticSymbol(filePath, symbolName);
      }

      // If no, try to find the symbol in one of the re-export location
      if (metadata.exports) {
        // Try and find the symbol in the list of explicitly re-exported symbols.
        for (const moduleExport of metadata.exports) {
          if (moduleExport.export) {
            const exportSymbol = moduleExport.export.find(symbol => {
              if (typeof symbol === 'string') {
                return symbol == symbolName;
              } else {
                return symbol.as == symbolName;
              }
            });
            if (exportSymbol) {
              let symName = symbolName;
              if (typeof exportSymbol !== 'string') {
                symName = exportSymbol.name;
              }
              return this.resolveExportedSymbol(resolveModule(moduleExport.from), symName);
            }
          }
        }

        // Try to find the symbol via export * directives.
        for (const moduleExport of metadata.exports) {
          if (!moduleExport.export) {
            const resolvedModule = resolveModule(moduleExport.from);
            const candidateSymbol = this.resolveExportedSymbol(resolvedModule, symbolName);
            if (candidateSymbol) return candidateSymbol;
          }
        }
      }
    }
    return null;
  }
}

export class NodeReflectorHostContext implements ReflectorHostContext {
  private assumedExists: {[fileName: string]: boolean} = {};

  fileExists(fileName: string): boolean {
    return this.assumedExists[fileName] || fs.existsSync(fileName);
  }

  directoryExists(directoryName: string): boolean {
    try {
      return fs.statSync(directoryName).isDirectory();
    } catch (e) {
      return false;
    }
  }

  readFile(fileName: string): string { return fs.readFileSync(fileName, 'utf8'); }

  assumeFileExists(fileName: string): void { this.assumedExists[fileName] = true; }
}
