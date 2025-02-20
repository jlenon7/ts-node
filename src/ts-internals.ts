import { isAbsolute, resolve } from 'path';
import { cachedLookup, normalizeSlashes } from './util';
import type * as _ts from 'typescript';
import type { TSCommon, TSInternal } from './ts-compiler-types';

/** @internal */
export const createTsInternals = cachedLookup(createTsInternalsUncached);
/**
 * Given a reference to the TS compiler, return some TS internal functions that we
 * could not or did not want to grab off the `ts` object.
 * These have been copy-pasted from TS's source and tweaked as necessary.
 *
 * NOTE: This factory returns *only* functions which need a reference to the TS
 * compiler.  Other functions do not need a reference to the TS compiler so are
 * exported directly from this file.
 */
function createTsInternalsUncached(_ts: TSCommon) {
  const ts = _ts as TSCommon & TSInternal;
  /**
   * Copied from:
   * https://github.com/microsoft/TypeScript/blob/v4.3.2/src/compiler/commandLineParser.ts#L2821-L2846
   */
  function getExtendsConfigPath(
    extendedConfig: string,
    host: _ts.ParseConfigHost,
    basePath: string,
    errors: _ts.Push<_ts.Diagnostic>,
    createDiagnostic: (message: _ts.DiagnosticMessage, arg1?: string) => _ts.Diagnostic
  ) {
    extendedConfig = normalizeSlashes(extendedConfig);
    if (isRootedDiskPath(extendedConfig) || startsWith(extendedConfig, './') || startsWith(extendedConfig, '../')) {
      let extendedConfigPath = getNormalizedAbsolutePath(extendedConfig, basePath);
      if (!host.fileExists(extendedConfigPath) && !endsWith(extendedConfigPath, ts.Extension.Json)) {
        extendedConfigPath = `${extendedConfigPath}.json`;
        if (!host.fileExists(extendedConfigPath)) {
          errors.push(createDiagnostic(ts.Diagnostics.File_0_not_found, extendedConfig));
          return undefined;
        }
      }
      return extendedConfigPath;
    }
    // If the path isn't a rooted or relative path, resolve like a module
    const resolved = ts.nodeModuleNameResolver(
      extendedConfig,
      combinePaths(basePath, 'tsconfig.json'),
      { moduleResolution: ts.ModuleResolutionKind.NodeJs },
      host,
      /*cache*/ undefined,
      /*projectRefs*/ undefined,
      /*lookupConfig*/ true
    );
    if (resolved.resolvedModule) {
      return resolved.resolvedModule.resolvedFileName;
    }
    errors.push(createDiagnostic(ts.Diagnostics.File_0_not_found, extendedConfig));
    return undefined;
  }

  return { getExtendsConfigPath };
}

// These functions have alternative implementation to avoid copying too much from TS
function isRootedDiskPath(path: string) {
  return isAbsolute(path);
}
function combinePaths(path: string, ...paths: (string | undefined)[]): string {
  return normalizeSlashes(resolve(path, ...(paths.filter((path) => path) as string[])));
}
function getNormalizedAbsolutePath(fileName: string, currentDirectory: string | undefined) {
  return normalizeSlashes(currentDirectory != null ? resolve(currentDirectory!, fileName) : resolve(fileName));
}

function startsWith(str: string, prefix: string): boolean {
  return str.lastIndexOf(prefix, 0) === 0;
}

function endsWith(str: string, suffix: string): boolean {
  const expectedPos = str.length - suffix.length;
  return expectedPos >= 0 && str.indexOf(suffix, expectedPos) === expectedPos;
}
// Reserved characters, forces escaping of any non-word (or digit), non-whitespace character.
// It may be inefficient (we could just match (/[-[\]{}()*+?.,\\^$|#\s]/g), but this is future
// proof.
const reservedCharacterPattern = /[^\w\s\/]/g;

/**
 * @internal
 * See also: getRegularExpressionForWildcard, which seems to do almost the same thing
 */
export function getPatternFromSpec(spec: string, basePath: string) {
  const pattern = spec && getSubPatternFromSpec(spec, basePath, excludeMatcher);
  return pattern && `^(${pattern})${'($|/)'}`;
}
function getSubPatternFromSpec(
  spec: string,
  basePath: string,
  { singleAsteriskRegexFragment, doubleAsteriskRegexFragment, replaceWildcardCharacter }: WildcardMatcher
): string {
  let subpattern = '';
  let hasWrittenComponent = false;
  const components = getNormalizedPathComponents(spec, basePath);
  const lastComponent = last(components);

  // getNormalizedPathComponents includes the separator for the root component.
  // We need to remove to create our regex correctly.
  components[0] = removeTrailingDirectorySeparator(components[0]);

  if (isImplicitGlob(lastComponent)) {
    components.push('**', '*');
  }

  let optionalCount = 0;
  for (let component of components) {
    if (component === '**') {
      subpattern += doubleAsteriskRegexFragment;
    } else {
      if (hasWrittenComponent) {
        subpattern += directorySeparator;
      }
      subpattern += component.replace(reservedCharacterPattern, replaceWildcardCharacter);
    }

    hasWrittenComponent = true;
  }

  while (optionalCount > 0) {
    subpattern += ')?';
    optionalCount--;
  }

  return subpattern;
}
interface WildcardMatcher {
  singleAsteriskRegexFragment: string;
  doubleAsteriskRegexFragment: string;
  replaceWildcardCharacter: (match: string) => string;
}
const directoriesMatcher: WildcardMatcher = {
  singleAsteriskRegexFragment: '[^/]*',
  /**
   * Regex for the ** wildcard. Matches any num of subdirectories. When used for including
   * files or directories, does not match subdirectories that start with a . character
   */
  doubleAsteriskRegexFragment: `(/[^/.][^/]*)*?`,
  replaceWildcardCharacter: (match) => replaceWildcardCharacter(match, directoriesMatcher.singleAsteriskRegexFragment),
};
const excludeMatcher: WildcardMatcher = {
  singleAsteriskRegexFragment: '[^/]*',
  doubleAsteriskRegexFragment: '(/.+?)?',
  replaceWildcardCharacter: (match) => replaceWildcardCharacter(match, excludeMatcher.singleAsteriskRegexFragment),
};
function getNormalizedPathComponents(path: string, currentDirectory: string | undefined) {
  return reducePathComponents(getPathComponents(path, currentDirectory));
}
function getPathComponents(path: string, currentDirectory = '') {
  path = combinePaths(currentDirectory, path);
  return pathComponents(path, getRootLength(path));
}
function reducePathComponents(components: readonly string[]) {
  if (!some(components)) return [];
  const reduced = [components[0]];
  for (let i = 1; i < components.length; i++) {
    const component = components[i];
    if (!component) continue;
    if (component === '.') continue;
    if (component === '..') {
      if (reduced.length > 1) {
        if (reduced[reduced.length - 1] !== '..') {
          reduced.pop();
          continue;
        }
      } else if (reduced[0]) continue;
    }
    reduced.push(component);
  }
  return reduced;
}
function getRootLength(path: string) {
  const rootLength = getEncodedRootLength(path);
  return rootLength < 0 ? ~rootLength : rootLength;
}
function getEncodedRootLength(path: string): number {
  if (!path) return 0;
  const ch0 = path.charCodeAt(0);

  // POSIX or UNC
  if (ch0 === CharacterCodes.slash || ch0 === CharacterCodes.backslash) {
    if (path.charCodeAt(1) !== ch0) return 1; // POSIX: "/" (or non-normalized "\")

    const p1 = path.indexOf(ch0 === CharacterCodes.slash ? directorySeparator : altDirectorySeparator, 2);
    if (p1 < 0) return path.length; // UNC: "//server" or "\\server"

    return p1 + 1; // UNC: "//server/" or "\\server\"
  }

  // DOS
  if (isVolumeCharacter(ch0) && path.charCodeAt(1) === CharacterCodes.colon) {
    const ch2 = path.charCodeAt(2);
    if (ch2 === CharacterCodes.slash || ch2 === CharacterCodes.backslash) return 3; // DOS: "c:/" or "c:\"
    if (path.length === 2) return 2; // DOS: "c:" (but not "c:d")
  }

  // URL
  const schemeEnd = path.indexOf(urlSchemeSeparator);
  if (schemeEnd !== -1) {
    const authorityStart = schemeEnd + urlSchemeSeparator.length;
    const authorityEnd = path.indexOf(directorySeparator, authorityStart);
    if (authorityEnd !== -1) {
      // URL: "file:///", "file://server/", "file://server/path"
      // For local "file" URLs, include the leading DOS volume (if present).
      // Per https://www.ietf.org/rfc/rfc1738.txt, a host of "" or "localhost" is a
      // special case interpreted as "the machine from which the URL is being interpreted".
      const scheme = path.slice(0, schemeEnd);
      const authority = path.slice(authorityStart, authorityEnd);
      if (
        scheme === 'file' &&
        (authority === '' || authority === 'localhost') &&
        isVolumeCharacter(path.charCodeAt(authorityEnd + 1))
      ) {
        const volumeSeparatorEnd = getFileUrlVolumeSeparatorEnd(path, authorityEnd + 2);
        if (volumeSeparatorEnd !== -1) {
          if (path.charCodeAt(volumeSeparatorEnd) === CharacterCodes.slash) {
            // URL: "file:///c:/", "file://localhost/c:/", "file:///c%3a/", "file://localhost/c%3a/"
            return ~(volumeSeparatorEnd + 1);
          }
          if (volumeSeparatorEnd === path.length) {
            // URL: "file:///c:", "file://localhost/c:", "file:///c$3a", "file://localhost/c%3a"
            // but not "file:///c:d" or "file:///c%3ad"
            return ~volumeSeparatorEnd;
          }
        }
      }
      return ~(authorityEnd + 1); // URL: "file://server/", "http://server/"
    }
    return ~path.length; // URL: "file://server", "http://server"
  }

  // relative
  return 0;
}
function ensureTrailingDirectorySeparator(path: string) {
  if (!hasTrailingDirectorySeparator(path)) {
    return path + directorySeparator;
  }

  return path;
}
function hasTrailingDirectorySeparator(path: string) {
  return path.length > 0 && isAnyDirectorySeparator(path.charCodeAt(path.length - 1));
}
function isAnyDirectorySeparator(charCode: number): boolean {
  return charCode === CharacterCodes.slash || charCode === CharacterCodes.backslash;
}
function removeTrailingDirectorySeparator(path: string) {
  if (hasTrailingDirectorySeparator(path)) {
    return path.substr(0, path.length - 1);
  }

  return path;
}
const directorySeparator = '/';
const altDirectorySeparator = '\\';
const urlSchemeSeparator = '://';
function isVolumeCharacter(charCode: number) {
  return (
    (charCode >= CharacterCodes.a && charCode <= CharacterCodes.z) ||
    (charCode >= CharacterCodes.A && charCode <= CharacterCodes.Z)
  );
}
function getFileUrlVolumeSeparatorEnd(url: string, start: number) {
  const ch0 = url.charCodeAt(start);
  if (ch0 === CharacterCodes.colon) return start + 1;
  if (ch0 === CharacterCodes.percent && url.charCodeAt(start + 1) === CharacterCodes._3) {
    const ch2 = url.charCodeAt(start + 2);
    if (ch2 === CharacterCodes.a || ch2 === CharacterCodes.A) return start + 3;
  }
  return -1;
}
function some<T>(array: readonly T[] | undefined): array is readonly T[];
function some<T>(array: readonly T[] | undefined, predicate: (value: T) => boolean): boolean;
function some<T>(array: readonly T[] | undefined, predicate?: (value: T) => boolean): boolean {
  if (array) {
    if (predicate) {
      for (const v of array) {
        if (predicate(v)) {
          return true;
        }
      }
    } else {
      return array.length > 0;
    }
  }
  return false;
}
/* @internal */
const enum CharacterCodes {
  _3 = 0x33,
  a = 0x61,
  z = 0x7a,
  A = 0x41,
  Z = 0x5a,
  asterisk = 0x2a, // *
  backslash = 0x5c, // \
  colon = 0x3a, // :
  percent = 0x25, // %
  question = 0x3f, // ?
  slash = 0x2f, // /
}
function pathComponents(path: string, rootLength: number) {
  const root = path.substring(0, rootLength);
  const rest = path.substring(rootLength).split(directorySeparator);
  if (rest.length && !lastOrUndefined(rest)) rest.pop();
  return [root, ...rest];
}
function lastOrUndefined<T>(array: readonly T[]): T | undefined {
  return array.length === 0 ? undefined : array[array.length - 1];
}
function last<T>(array: readonly T[]): T {
  // Debug.assert(array.length !== 0);
  return array[array.length - 1];
}
function replaceWildcardCharacter(match: string, singleAsteriskRegexFragment: string) {
  return match === '*' ? singleAsteriskRegexFragment : match === '?' ? '[^/]' : '\\' + match;
}
/**
 * An "includes" path "foo" is implicitly a glob "foo/** /*" (without the space) if its last component has no extension,
 * and does not contain any glob characters itself.
 */
function isImplicitGlob(lastPathComponent: string): boolean {
  return !/[.*?]/.test(lastPathComponent);
}

const ts_ScriptTarget_ES5 = 1;
const ts_ScriptTarget_ES2022 = 9;
const ts_ScriptTarget_ESNext = 99;
const ts_ModuleKind_Node16 = 100;
const ts_ModuleKind_NodeNext = 199;
// https://github.com/microsoft/TypeScript/blob/fc418a2e611c88cf9afa0115ff73490b2397d311/src/compiler/utilities.ts#L8761
export function getUseDefineForClassFields(compilerOptions: _ts.CompilerOptions): boolean {
  return compilerOptions.useDefineForClassFields === undefined
    ? getEmitScriptTarget(compilerOptions) >= ts_ScriptTarget_ES2022
    : compilerOptions.useDefineForClassFields;
}

// https://github.com/microsoft/TypeScript/blob/fc418a2e611c88cf9afa0115ff73490b2397d311/src/compiler/utilities.ts#L8556
export function getEmitScriptTarget(compilerOptions: {
  module?: _ts.CompilerOptions['module'];
  target?: _ts.CompilerOptions['target'];
}): _ts.ScriptTarget {
  return (
    compilerOptions.target ??
    ((compilerOptions.module === ts_ModuleKind_Node16 && ts_ScriptTarget_ES2022) ||
      (compilerOptions.module === ts_ModuleKind_NodeNext && ts_ScriptTarget_ESNext) ||
      ts_ScriptTarget_ES5)
  );
}
