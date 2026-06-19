import * as fs from "node:fs";
import * as path from "node:path";

let Parser: any = null;
let isInitialized = false;
let initPromise: Promise<void> | null = null;
const langCache = new Map<string, any>();
const queryCache = new Map<string, any>();

const EXT_TO_LANG: Record<string, string> = {
	ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
	py: "python", go: "go", rs: "rust", java: "java", c: "c",
	cpp: "cpp", cc: "cpp", h: "c", hpp: "cpp", cs: "c_sharp",
	rb: "ruby", php: "php", kt: "kotlin", swift: "swift",
	bash: "bash", sh: "bash", zsh: "bash", zig: "zig",
};

const QUERIES: Record<string, string> = {
	typescript: `(function_declaration name: (identifier) @name.definition.function) (class_declaration name: (type_identifier) @name.definition.class) (method_definition name: (property_identifier) @name.definition.method) (interface_declaration name: (type_identifier) @name.definition.interface) (type_alias_declaration name: (type_identifier) @name.definition.type) (variable_declarator name: (identifier) @name.definition.variable)`,
	javascript: `(function_declaration name: (identifier) @name.definition.function) (class_declaration name: (identifier) @name.definition.class) (method_definition name: (property_identifier) @name.definition.method) (variable_declarator name: (identifier) @name.definition.variable)`,
	python: `(function_definition name: (identifier) @name.definition.function) (class_definition name: (identifier) @name.definition.class)`,
	go: `(function_declaration name: (identifier) @name.definition.function) (method_declaration name: (field_identifier) @name.definition.method) (type_declaration (type_spec name: (type_identifier) @name.definition.type))`,
	rust: `(function_item name: (identifier) @name.definition.function) (struct_item name: (type_identifier) @name.definition.struct) (enum_item name: (type_identifier) @name.definition.enum) (trait_item name: (type_identifier) @name.definition.trait) (impl_item name: (type_identifier) @name.definition.impl)`,
	java: `(method_declaration name: (identifier) @name.definition.method) (class_declaration name: (identifier) @name.definition.class) (interface_declaration name: (identifier) @name.definition.interface)`,
	c: `(function_definition declarator: (declarator declarator: (identifier) @name.definition.function)) (struct_specifier name: (type_identifier) @name.definition.struct)`,
	cpp: `(function_definition declarator: (field_identifier) @name.definition.method) (class_specifier name: (type_identifier) @name.definition.class) (struct_specifier name: (type_identifier) @name.definition.struct)`,
	c_sharp: `(method_declaration name: (identifier) @name.definition.method) (class_declaration name: (identifier) @name.definition.class)`,
	ruby: `(method name: (identifier) @name.definition.method) (class name: (constant) @name.definition.class)`,
	php: `(function_definition name: (name) @name.definition.method) (class_declaration name: (name) @name.definition.class)`,
	kotlin: `(function_declaration name: (simple_identifier) @name.definition.method) (class_declaration name: (type_identifier) @name.definition.class)`,
	swift: `(function_declaration name: (identifier) @name.definition.method) (class_declaration name: (identifier) @name.definition.class) (struct_declaration name: (identifier) @name.definition.struct)`,
	bash: `(function_definition name: (word) @name.definition.function)`,
	zig: `(function_declaration name: (identifier) @name.definition.function)`,
};

export interface ParsedDefinition {
	lineIndex: number;
	text: string;
	indentation: string;
	lineCount?: number;
}

async function initParser() {
	if (isInitialized) return;
	if (!initPromise) {
		initPromise = (async () => {
			const mod = await import("web-tree-sitter");
			Parser = mod.default || mod;
			await Parser.init({
				locateFile(scriptName: string) {
					const wasmPath = path.join(
						process.cwd(),
						"node_modules",
						"web-tree-sitter",
						scriptName,
					);
					if (fs.existsSync(wasmPath)) return wasmPath;
					return scriptName;
				},
			});
			isInitialized = true;
		})();
	}
	return initPromise;
}

async function loadLanguage(langName: string): Promise<any> {
	if (langCache.has(langName)) return langCache.get(langName);
	const wasmName = `tree-sitter-${langName}.wasm`;
	const searchPaths = [
		path.join(process.cwd(), "node_modules", "tree-sitter-wasms", "out", wasmName),
		path.join(__dirname, "..", "node_modules", "tree-sitter-wasms", "out", wasmName),
	];
	for (const wasmPath of searchPaths) {
		try {
			const lang = await Parser.Language.load(wasmPath);
			langCache.set(langName, lang);
			return lang;
		} catch {}
	}
	throw new Error(`Could not load WASM for: ${langName}`);
}

function getQuery(langName: string, lang: any): any {
	const key = langName;
	if (queryCache.has(key)) return queryCache.get(key);
	const queryText = QUERIES[langName];
	if (!queryText) return null;
	const query = lang.query(queryText);
	queryCache.set(key, query);
	return query;
}

export async function parseFile(filePath: string): Promise<ParsedDefinition[] | null> {
	await initParser();
	const ext = path.extname(filePath).toLowerCase().slice(1);
	const langName = EXT_TO_LANG[ext];
	if (!langName) return null;

	const lang = await loadLanguage(langName);
	const query = getQuery(langName, lang);
	if (!query) return null;

	const fileContent = fs.readFileSync(filePath, "utf-8");
	const parser = new Parser();
	parser.setLanguage(lang);
	const tree = parser.parse(fileContent);
	if (!tree?.rootNode) return null;

	const captures = query.captures(tree.rootNode);
	captures.sort((a: any, b: any) => a.node.startPosition.row - b.node.startPosition.row);

	const lines = fileContent.split("\n");
	const definitions: ParsedDefinition[] = [];
	let lastLine = -1;

	for (const capture of captures) {
		const { node, name } = capture;
		if (!name.includes("name.definition")) continue;
		const startLine = node.startPosition.row;
		if (startLine <= lastLine || !lines[startLine]) continue;

		definitions.push({
			lineIndex: startLine,
			text: lines[startLine],
			indentation: lines[startLine].match(/^\s*/)?.[0] || "",
		});
		lastLine = startLine;
	}

	return definitions.length > 0 ? definitions : null;
}

export async function findSymbolReferences(
	filePath: string,
	symbolName: string,
): Promise<{ line: number; text: string }[]> {
	await initParser();
	const ext = path.extname(filePath).toLowerCase().slice(1);
	const langName = EXT_TO_LANG[ext];
	if (!langName) return [];

	const lang = await loadLanguage(langName);
	const fileContent = fs.readFileSync(filePath, "utf-8");
	const parser = new Parser();
	parser.setLanguage(lang);
	const tree = parser.parse(fileContent);
	if (!tree?.rootNode) return [];

	const results: { line: number; text: string }[] = [];
	const lines = fileContent.split("\n");

	function walk(node: any) {
		if (node.text === symbolName) {
			results.push({
				line: node.startPosition.row,
				text: lines[node.startPosition.row] || "",
			});
		}
		for (let i = 0; i < node.childCount; i++) {
			walk(node.child(i));
		}
	}
	walk(tree.rootNode);
	return results;
}

export function isSupported(filePath: string): boolean {
	const ext = path.extname(filePath).toLowerCase().slice(1);
	return ext in EXT_TO_LANG;
}
