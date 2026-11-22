/**
 * Symbol Extractor — extracts symbols from tree-sitter ASTs.
 *
 * Per-language node type mappings for functions, classes, methods, interfaces, etc.
 * Output format matches LSP DocumentSymbol shape for compatibility.
 */

import type Parser from "web-tree-sitter";

type Tree = Parser.Tree;
type Node = Parser.SyntaxNode;

/** Symbol kinds matching LSP SymbolKind values */
export const SymbolKind = {
  File: 1, Module: 2, Namespace: 3, Package: 4, Class: 5, Method: 6,
  Property: 7, Field: 8, Constructor: 9, Enum: 10, Interface: 11,
  Function: 12, Variable: 13, Constant: 14, String: 15, Number: 16,
  Boolean: 17, Array: 18, Object: 19, Struct: 22,
} as const;

export type SymbolKindValue = typeof SymbolKind[keyof typeof SymbolKind];

export interface SymbolInfo {
  name: string;
  kind: SymbolKindValue;
  line: number;      // 1-indexed
  endLine: number;   // 1-indexed
  children?: SymbolInfo[];
}

/** Node types that represent symbol declarations, per language family */
interface SymbolMapping {
  nodeType: string;
  kind: SymbolKindValue;
  /** Field name to extract the symbol name from (default: "name") */
  nameField?: string;
  /** Whether to recurse into children for nested symbols */
  recurse?: boolean;
}

const TS_JS_SYMBOLS: SymbolMapping[] = [
  { nodeType: "function_declaration", kind: SymbolKind.Function },
  { nodeType: "class_declaration", kind: SymbolKind.Class, recurse: true },
  { nodeType: "interface_declaration", kind: SymbolKind.Interface, recurse: true },
  { nodeType: "enum_declaration", kind: SymbolKind.Enum, recurse: true },
  { nodeType: "type_alias_declaration", kind: SymbolKind.Variable },
  { nodeType: "method_definition", kind: SymbolKind.Method },
  { nodeType: "public_field_definition", kind: SymbolKind.Field },
  { nodeType: "abstract_method_signature", kind: SymbolKind.Method },
  { nodeType: "lexical_declaration", kind: SymbolKind.Variable },
  { nodeType: "variable_declaration", kind: SymbolKind.Variable },
];

const PYTHON_SYMBOLS: SymbolMapping[] = [
  { nodeType: "function_definition", kind: SymbolKind.Function },
  { nodeType: "class_definition", kind: SymbolKind.Class, recurse: true },
  { nodeType: "decorated_definition", kind: SymbolKind.Function },
];

const RUST_SYMBOLS: SymbolMapping[] = [
  { nodeType: "function_item", kind: SymbolKind.Function },
  { nodeType: "struct_item", kind: SymbolKind.Struct },
  { nodeType: "enum_item", kind: SymbolKind.Enum, recurse: true },
  { nodeType: "impl_item", kind: SymbolKind.Class, recurse: true },
  { nodeType: "trait_item", kind: SymbolKind.Interface, recurse: true },
  { nodeType: "mod_item", kind: SymbolKind.Module, recurse: true },
  { nodeType: "type_item", kind: SymbolKind.Variable },
  { nodeType: "const_item", kind: SymbolKind.Constant },
  { nodeType: "static_item", kind: SymbolKind.Constant },
  { nodeType: "macro_definition", kind: SymbolKind.Function },
];

const GO_SYMBOLS: SymbolMapping[] = [
  { nodeType: "function_declaration", kind: SymbolKind.Function },
  { nodeType: "method_declaration", kind: SymbolKind.Method },
  { nodeType: "type_declaration", kind: SymbolKind.Class },
  { nodeType: "type_spec", kind: SymbolKind.Class },
  { nodeType: "const_declaration", kind: SymbolKind.Constant },
  { nodeType: "var_declaration", kind: SymbolKind.Variable },
];

const JAVA_SYMBOLS: SymbolMapping[] = [
  { nodeType: "class_declaration", kind: SymbolKind.Class, recurse: true },
  { nodeType: "interface_declaration", kind: SymbolKind.Interface, recurse: true },
  { nodeType: "enum_declaration", kind: SymbolKind.Enum, recurse: true },
  { nodeType: "method_declaration", kind: SymbolKind.Method },
  { nodeType: "constructor_declaration", kind: SymbolKind.Constructor },
  { nodeType: "field_declaration", kind: SymbolKind.Field },
  { nodeType: "annotation_type_declaration", kind: SymbolKind.Interface },
];

const C_CPP_SYMBOLS: SymbolMapping[] = [
  { nodeType: "function_definition", kind: SymbolKind.Function },
  { nodeType: "declaration", kind: SymbolKind.Variable },
  { nodeType: "struct_specifier", kind: SymbolKind.Struct },
  { nodeType: "enum_specifier", kind: SymbolKind.Enum },
  { nodeType: "class_specifier", kind: SymbolKind.Class, recurse: true },
  { nodeType: "namespace_definition", kind: SymbolKind.Namespace, recurse: true },
];

const RUBY_SYMBOLS: SymbolMapping[] = [
  { nodeType: "method", kind: SymbolKind.Method },
  { nodeType: "singleton_method", kind: SymbolKind.Method },
  { nodeType: "class", kind: SymbolKind.Class, recurse: true },
  { nodeType: "module", kind: SymbolKind.Module, recurse: true },
];

const CSHARP_SYMBOLS: SymbolMapping[] = [
  { nodeType: "namespace_declaration", kind: SymbolKind.Namespace, recurse: true },
  { nodeType: "file_scoped_namespace_declaration", kind: SymbolKind.Namespace, recurse: true },
  { nodeType: "class_declaration", kind: SymbolKind.Class, recurse: true },
  { nodeType: "record_declaration", kind: SymbolKind.Class, recurse: true },
  { nodeType: "struct_declaration", kind: SymbolKind.Struct, recurse: true },
  { nodeType: "interface_declaration", kind: SymbolKind.Interface, recurse: true },
  { nodeType: "enum_declaration", kind: SymbolKind.Enum, recurse: true },
  { nodeType: "method_declaration", kind: SymbolKind.Method },
  { nodeType: "constructor_declaration", kind: SymbolKind.Constructor },
  { nodeType: "property_declaration", kind: SymbolKind.Property },
  { nodeType: "field_declaration", kind: SymbolKind.Field },
];

const LANGUAGE_SYMBOLS: Record<string, SymbolMapping[]> = {
  typescript: TS_JS_SYMBOLS,
  typescriptreact: TS_JS_SYMBOLS,
  javascript: TS_JS_SYMBOLS,
  javascriptreact: TS_JS_SYMBOLS,
  python: PYTHON_SYMBOLS,
  rust: RUST_SYMBOLS,
  go: GO_SYMBOLS,
  java: JAVA_SYMBOLS,
  c: C_CPP_SYMBOLS,
  cpp: C_CPP_SYMBOLS,
  ruby: RUBY_SYMBOLS,
  csharp: CSHARP_SYMBOLS,
};

/**
 * Extract symbols from a parsed tree.
 */
export function extractSymbols(tree: Tree, languageId: string): SymbolInfo[] {
  const mappings = LANGUAGE_SYMBOLS[languageId];
  if (!mappings) return extractGenericSymbols(tree);
  return extractFromNode(tree.rootNode, mappings, languageId);
}

function extractFromNode(node: Node, mappings: SymbolMapping[], languageId: string, deep = false): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];

  for (const child of node.namedChildren) {
    const mapping = mappings.find((m) => m.nodeType === child.type);
    if (mapping) {
      const name = extractName(child, mapping, languageId);
      if (name) {
        const sym: SymbolInfo = {
          name,
          kind: mapping.kind,
          line: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
        };
        if (mapping.recurse) {
          const children = extractFromNode(child, mappings, languageId, true);
          if (children.length > 0) sym.children = children;
        }
        symbols.push(sym);
      }
    } else if (child.type === "export_statement" && (languageId.startsWith("typescript") || languageId.startsWith("javascript"))) {
      // Unwrap export statements to find the actual declaration
      const inner = extractFromNode(child, mappings, languageId, deep);
      symbols.push(...inner);
    } else if (deep && child.namedChildCount > 0) {
      // Walk through container nodes (class_body, interface_body, etc.)
      // to find nested declarations when recursing inside a parent
      symbols.push(...extractFromNode(child, mappings, languageId, true));
    }
  }

  return symbols;
}

/** Extract the name of a symbol from a node */
function extractName(node: Node, mapping: SymbolMapping, languageId: string): string | null {
  // Try the "name" field first (works for most declarations)
  const nameNode = node.childForFieldName(mapping.nameField ?? "name");
  if (nameNode) return nameNode.text;

  // Language-specific fallbacks
  switch (node.type) {
    case "lexical_declaration":
    case "variable_declaration": {
      // const foo = ..., let bar = ...
      const declarator = node.namedChildren.find(
        (c) => c.type === "variable_declarator" || c.type === "init_declarator"
      );
      if (declarator) {
        const n = declarator.childForFieldName("name");
        return n?.text ?? null;
      }
      return null;
    }
    case "decorated_definition": {
      // Python: @decorator \n def foo(): ...
      const inner = node.namedChildren.find(
        (c) => c.type === "function_definition" || c.type === "class_definition"
      );
      if (inner) {
        const n = inner.childForFieldName("name");
        return n?.text ?? null;
      }
      return null;
    }
    case "impl_item": {
      // Rust: impl Foo { ... } or impl Trait for Foo { ... }
      const typeNode = node.childForFieldName("type");
      if (typeNode) return `impl ${typeNode.text}`;
      return null;
    }
    case "type_declaration": {
      // Go: type Foo struct { ... }
      const spec = node.namedChildren.find((c) => c.type === "type_spec");
      if (spec) {
        const n = spec.childForFieldName("name");
        return n?.text ?? null;
      }
      return null;
    }
    case "const_declaration":
    case "var_declaration": {
      // Go: const/var declarations
      const spec = node.namedChildren.find(
        (c) => c.type === "const_spec" || c.type === "var_spec"
      );
      if (spec) {
        const n = spec.childForFieldName("name");
        return n?.text ?? null;
      }
      return null;
    }
    case "field_declaration": {
      // Java: the declarators are children of the field. C#: they are inside a variable_declaration.
      const holder = node.namedChildren.find((c) => c.type === "variable_declaration") ?? node;
      const declarator = holder.namedChildren.find((c) => c.type === "variable_declarator");
      if (declarator) {
        const n = declarator.childForFieldName("name") ?? declarator.namedChildren.find((c) => c.type === "identifier");
        return n?.text ?? null;
      }
      return null;
    }
    case "declaration": {
      // C/C++: declarations
      const declarator = node.namedChildren.find(
        (c) => c.type === "init_declarator" || c.type === "function_declarator"
      );
      if (declarator) {
        const n = declarator.childForFieldName("declarator") ?? declarator.childForFieldName("name");
        return n?.text ?? null;
      }
      return null;
    }
    default:
      break;
  }

  // Last resort: first named child's text (truncated)
  const first = node.firstNamedChild;
  if (first && first.text.length < 60) return first.text;
  return null;
}

/** Generic fallback for languages without specific mappings */
function extractGenericSymbols(tree: Tree): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];
  const root = tree.rootNode;

  for (const child of root.namedChildren) {
    // Look for common declaration patterns
    if (child.type.includes("function") || child.type.includes("method")) {
      const name = child.childForFieldName("name")?.text;
      if (name) {
        symbols.push({
          name,
          kind: SymbolKind.Function,
          line: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
        });
      }
    } else if (child.type.includes("class") || child.type.includes("struct")) {
      const name = child.childForFieldName("name")?.text;
      if (name) {
        symbols.push({
          name,
          kind: SymbolKind.Class,
          line: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
        });
      }
    }
  }

  return symbols;
}

/**
 * Get the named node at a specific position in the tree.
 * Returns the smallest named node that contains the position.
 */
export function getNodeAtPosition(tree: Tree, line: number, character: number): Node | null {
  // tree-sitter uses 0-indexed positions
  const point = { row: line, column: character };
  return tree.rootNode.namedDescendantForPosition(point);
}

/**
 * Find definition(s) of a symbol name within a tree.
 * Searches for declaration nodes whose name matches.
 */
export function findDefinition(tree: Tree, symbolName: string, languageId: string): SymbolInfo[] {
  const allSymbols = extractSymbols(tree, languageId);
  return findSymbolByName(allSymbols, symbolName);
}

function findSymbolByName(symbols: SymbolInfo[], name: string): SymbolInfo[] {
  const results: SymbolInfo[] = [];
  for (const sym of symbols) {
    if (sym.name === name) results.push(sym);
    if (sym.children) results.push(...findSymbolByName(sym.children, name));
  }
  return results;
}

/**
 * Get syntax errors from a parsed tree.
 * Returns ERROR and MISSING nodes as diagnostic-like objects.
 */
export function getSyntaxErrors(tree: Tree): Array<{
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
  message: string;
}> {
  const errors: Array<{
    line: number;
    character: number;
    endLine: number;
    endCharacter: number;
    message: string;
  }> = [];

  function walk(node: Node): void {
    if (node.isError) {
      errors.push({
        line: node.startPosition.row,
        character: node.startPosition.column,
        endLine: node.endPosition.row,
        endCharacter: node.endPosition.column,
        message: `Syntax error: unexpected "${node.text.slice(0, 50)}${node.text.length > 50 ? "..." : ""}"`,
      });
    } else if (node.isMissing) {
      errors.push({
        line: node.startPosition.row,
        character: node.startPosition.column,
        endLine: node.endPosition.row,
        endCharacter: node.endPosition.column,
        message: `Missing ${node.type}`,
      });
    } else if (node.hasError) {
      // Recurse into children only if this node contains errors
      for (const child of node.children) {
        walk(child);
      }
    }
  }

  walk(tree.rootNode);
  return errors;
}

/**
 * Get the signature text for a node (for hover info).
 * Extracts the first line of the declaration.
 */
export function getSignatureText(node: Node): string {
  const text = node.text;
  const firstLine = text.split("\n")[0];
  // Trim trailing { or : for cleaner display
  return firstLine.replace(/\s*[{:]\s*$/, "").trim();
}

/**
 * Get the enclosing declaration node for a position.
 * Walks up from the node at position to find the nearest declaration.
 */
export function getEnclosingDeclaration(tree: Tree, line: number, character: number): Node | null {
  const point = { row: line, column: character };
  let node: Node | null = tree.rootNode.namedDescendantForPosition(point);

  const declarationTypes = new Set([
    "function_declaration", "function_definition", "function_item",
    "method_declaration", "method_definition",
    "class_declaration", "class_definition", "class_specifier",
    "interface_declaration", "enum_declaration", "enum_item",
    "struct_item", "impl_item", "trait_item", "mod_item",
    "type_alias_declaration", "type_declaration",
    "variable_declarator", "lexical_declaration",
    "const_item", "static_item",
    "decorated_definition",
  ]);

  while (node) {
    if (declarationTypes.has(node.type)) return node;
    node = node.parent;
  }
  return null;
}
