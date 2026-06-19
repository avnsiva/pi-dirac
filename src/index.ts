/**
 * pi-dirac: Dirac's best features for Pi
 *
 * - Hash-anchored edits (override edit tool with lineRef support)
 * - AST tools (skeleton, get_function, find_references, rename/replace)
 * - Condense tool (expose compaction engine)
 * - Diagnostics scan (run linters via exec)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolve as pathResolve } from "node:path";
import { readFileSync } from "node:fs";

import {
	annotateLinesWithAnchors,
	anchorState,
	resolveLineRef,
	extractId,
	ANCHOR_DELIMITER,
} from "./line-hashing.ts";

import { parseFile, findSymbolReferences, isSupported } from "./tree-sitter.ts";

export default function (pi: ExtensionAPI) {
	// ── Hash-Anchored Edits ──────────────────────────────────────────────

	pi.on("before_agent_start", async (event, _ctx) => {
		const hashInstructions = `
## Hash-Anchored Edit Mode (Active)

When reading files, you will see line anchors: \`SymbolName§line content\` or \`LineNumber§line content\`.
When editing, use the \`edit\` tool with \`lineRef\` inside the \`edits\` array:
\`{ "path": "file.ts", "edits": [{ "lineRef": "MyFunction§    return x + 1;", "newText": "    return x + 2;" }] }\`
This is more reliable than copying exact text. Always prefer lineRef when anchors are visible.`;

		if (!event.systemPrompt.includes("Hash-Anchored Edit Mode")) {
			return { systemPrompt: event.systemPrompt + hashInstructions };
		}
	});

	// Cache file content when read is called
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "read") {
			const input = event.input as any;
			const filePath = input.path;
			const absPath = filePath.startsWith("/") ? filePath : pathResolve(ctx.cwd, filePath);
			try {
				const content = readFileSync(absPath, "utf-8");
				anchorState.set(absPath, content);
			} catch {}
		}
	});

	// Post-process read results to add hash anchors
	pi.on("tool_result", async (event, _ctx) => {
		if (event.toolName !== "read") return;
		if (!event.content || event.content.length === 0) return;

		const textBlock = event.content.find((c: any) => c.type === "text");
		if (!textBlock) return;

		const input = (event as any).input;
		const filePath = input?.path;
		if (!filePath) return;

		const absPath = filePath.startsWith("/") ? filePath : filePath;
		const originalContent = anchorState.get(absPath);
		if (!originalContent) return;

		const annotated = annotateLinesWithAnchors(originalContent, absPath);

		const modifiedContent = event.content.map((c: any) => {
			if (c.type === "text") {
				return { ...c, text: annotated };
			}
			return c;
		});

		return { content: modifiedContent };
	});

	// ── Override Edit Tool with lineRef Support ──────────────────────────

	pi.registerTool({
		name: "edit",
		label: "Edit",
		description:
			"Apply edits to a file. Each edit has oldText (text to find) and newText (replacement). Use lineRef instead of oldText when hash anchors are visible from a recent read.",
		parameters: Type.Object({
			path: Type.String({ description: "Absolute path to the file to edit" }),
			edits: Type.Array(
				Type.Object({
					oldText: Type.Optional(Type.String({ description: "Exact text to find and replace" })),
					newText: Type.String({ description: "Replacement text" }),
					lineRef: Type.Optional(
						Type.String({
							description:
								"Hash-anchored line reference from read output (e.g., MyFunction§    return x;). Resolves to oldText automatically.",
						}),
					),
				}),
				{ description: "Array of edits to apply" },
			),
		}),
		prepareArguments(args: any) {
			// Resolve lineRef to oldText before schema validation
			if (args.edits && Array.isArray(args.edits)) {
				for (const edit of args.edits) {
					if (edit.lineRef && !edit.oldText) {
						const filePath = args.path;
						const absPath = filePath.startsWith("/") ? filePath : filePath;
						const fileContent = anchorState.get(absPath);
						if (fileContent) {
							const resolved = resolveLineRef(edit.lineRef, fileContent);
							if (resolved) {
								edit.oldText = resolved;
							}
						}
						delete edit.lineRef;
					} else if (edit.lineRef && edit.oldText) {
						delete edit.lineRef;
					}
				}
			}
			return args;
		},
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const { editFile } = await import("./edit-impl.ts");
			return editFile(params, ctx);
		},
	});

	// ── AST Skeleton Tool ────────────────────────────────────────────────

	pi.registerTool({
		name: "ast_skeleton",
		label: "AST Skeleton",
		description: "Show file structure (functions, classes, imports) using tree-sitter AST parsing",
		parameters: Type.Object({
			path: Type.String({ description: "File path to analyze" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const absPath = params.path.startsWith("/") ? params.path : pathResolve(ctx.cwd, params.path);

			if (!isSupported(absPath)) {
				const ext = absPath.split(".").pop();
				return {
					content: [{ type: "text", text: `Unsupported file type: .${ext}` }],
					details: {},
				};
			}

			const defs = await parseFile(absPath);
			if (!defs || defs.length === 0) {
				return {
					content: [{ type: "text", text: "No structural definitions found" }],
					details: {},
				};
			}

			const skeleton = defs
				.map((d) => {
					const trimmed = d.text.trimStart();
					const kind = trimmed.startsWith("class")
						? "class"
						: trimmed.startsWith("function") || trimmed.startsWith("def") || trimmed.startsWith("fn")
							? "function"
							: trimmed.startsWith("interface")
								? "interface"
								: trimmed.startsWith("type")
									? "type"
									: trimmed.startsWith("struct")
										? "struct"
										: trimmed.startsWith("enum")
											? "enum"
											: trimmed.startsWith("import") || trimmed.startsWith("from")
												? "import"
												: "definition";
					return `L${d.lineIndex + 1} [${kind}] ${d.text.trim()}`;
				})
				.join("\n");

			return {
				content: [{ type: "text", text: `File skeleton (${defs.length} definitions):\n${skeleton}` }],
				details: { definitions: defs.length },
			};
		},
	});

	// ── AST Get Function Tool ────────────────────────────────────────────

	pi.registerTool({
		name: "ast_get_function",
		label: "AST Get Function",
		description: "Extract a specific function or class body by name from a file",
		parameters: Type.Object({
			path: Type.String({ description: "File path" }),
			name: Type.String({ description: "Function or class name to extract" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const absPath = params.path.startsWith("/") ? params.path : pathResolve(ctx.cwd, params.path);

			if (!isSupported(absPath)) {
				return {
					content: [{ type: "text", text: `Unsupported file type` }],
					details: {},
				};
			}

			const defs = await parseFile(absPath);
			if (!defs) {
				return {
					content: [{ type: "text", text: "Could not parse file" }],
					details: {},
				};
			}

			const target = defs.find((d) => d.text.includes(params.name));
			if (!target) {
				return {
					content: [{ type: "text", text: `Symbol "${params.name}" not found in file` }],
					details: {},
				};
			}

			const content = readFileSync(absPath, "utf-8");
			const lines = content.split("\n");
			const startLine = target.lineIndex;
			const startIndent = target.indentation.length;
			let endLine = startLine;
			const ext = absPath.split(".").pop() || "";
			const isBraceLanguage = ["ts", "tsx", "js", "jsx", "java", "kt", "go", "rs", "c", "cpp", "cs", "php", "swift", "zig"].includes(ext);

			if (isBraceLanguage) {
				let braceDepth = 0;
				let foundOpenBrace = false;
				for (let i = startLine; i < lines.length; i++) {
					for (const ch of lines[i]) {
						if (ch === "{") { braceDepth++; foundOpenBrace = true; }
						else if (ch === "}") braceDepth--;
					}
					if (foundOpenBrace && braceDepth <= 0) {
						endLine = i;
						break;
					}
					endLine = i;
				}
			} else {
				for (let i = startLine + 1; i < lines.length; i++) {
					const lineIndent = (lines[i].match(/^\s*/)?.[0] || "").length;
					if (lineIndent <= startIndent && lines[i].trim().length > 0) {
						endLine = i - 1;
						break;
					}
					endLine = i;
				}
			}

			const body = lines.slice(startLine, endLine + 1).join("\n");
			return {
				content: [{ type: "text", text: body }],
				details: { startLine: startLine + 1, endLine: endLine + 1 },
			};
		},
	});

	// ── Find Symbol References Tool ──────────────────────────────────────

	pi.registerTool({
		name: "find_symbol_references",
		label: "Find Symbol References",
		description: "Find all usages/references of a symbol in a file using AST parsing",
		parameters: Type.Object({
			path: Type.String({ description: "File path to search" }),
			name: Type.String({ description: "Symbol name to find references for" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const absPath = params.path.startsWith("/") ? params.path : pathResolve(ctx.cwd, params.path);

			if (!isSupported(absPath)) {
				return {
					content: [{ type: "text", text: `Unsupported file type` }],
					details: {},
				};
			}

			const refs = await findSymbolReferences(absPath, params.name);
			if (refs.length === 0) {
				return {
					content: [{ type: "text", text: `No references to "${params.name}" found` }],
					details: {},
				};
			}

			const formatted = refs.map((r) => `L${r.line + 1}: ${r.text.trim()}`).join("\n");
			return {
				content: [{ type: "text", text: `Found ${refs.length} references to "${params.name}":\n${formatted}` }],
				details: { count: refs.length },
			};
		},
	});

	// ── Rename Symbol Tool ───────────────────────────────────────────────

	pi.registerTool({
		name: "rename_symbol",
		label: "Rename Symbol",
		description: "Rename a symbol (function, class, variable) across a file using AST parsing",
		parameters: Type.Object({
			path: Type.String({ description: "File path" }),
			oldName: Type.String({ description: "Current symbol name" }),
			newName: Type.String({ description: "New symbol name" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const absPath = params.path.startsWith("/") ? params.path : pathResolve(ctx.cwd, params.path);
			const content = readFileSync(absPath, "utf-8");
			const lines = content.split("\n");

			const refs = await findSymbolReferences(absPath, params.oldName);
			if (refs.length === 0) {
				return {
					content: [{ type: "text", text: `No references to "${params.oldName}" found` }],
					details: {},
				};
			}

			const edited = lines.map((line) => {
				const regex = new RegExp(`\\b${params.oldName}\\b`, "g");
				return line.replace(regex, params.newName);
			});

			const { writeFileSync } = await import("node:fs");
			writeFileSync(absPath, edited.join("\n"), "utf-8");

			return {
				content: [{ type: "text", text: `Renamed "${params.oldName}" → "${params.newName}" (${refs.length} occurrences)` }],
				details: { occurrences: refs.length },
			};
		},
	});

	// ── Replace Symbol Tool ──────────────────────────────────────────────

	pi.registerTool({
		name: "replace_symbol",
		label: "Replace Symbol",
		description: "Replace a function/class body at a specific line using numeric line reference",
		parameters: Type.Object({
			path: Type.String({ description: "File path" }),
			lineRef: Type.String({ description: "Line reference (e.g., 14 or MyFunction§...)" }),
			newText: Type.String({ description: "New content to replace the symbol body with" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const absPath = params.path.startsWith("/") ? params.path : pathResolve(ctx.cwd, params.path);
			const content = readFileSync(absPath, "utf-8");
			const lines = content.split("\n");
			const id = extractId(params.lineRef);

			let targetLine = -1;
			const numericId = Number.parseInt(id, 10);
			if (!Number.isNaN(numericId) && numericId >= 1 && numericId <= lines.length) {
				targetLine = numericId - 1;
			}

			if (targetLine === -1) {
				return {
					content: [{ type: "text", text: `Could not resolve lineRef: ${params.lineRef}. Use numeric line number (e.g., 14).` }],
					details: {},
				};
			}

			const startIndent = (lines[targetLine].match(/^\s*/)?.[0] || "").length;
			let endLine = targetLine;
			const ext = absPath.split(".").pop() || "";
			const isBraceLanguage = ["ts", "tsx", "js", "jsx", "java", "kt", "go", "rs", "c", "cpp", "cs", "php", "swift", "zig"].includes(ext);

			if (isBraceLanguage) {
				let braceDepth = 0;
				let foundOpenBrace = false;
				for (let i = targetLine; i < lines.length; i++) {
					for (const ch of lines[i]) {
						if (ch === "{") { braceDepth++; foundOpenBrace = true; }
						else if (ch === "}") braceDepth--;
					}
					if (foundOpenBrace && braceDepth <= 0) {
						endLine = i;
						break;
					}
					endLine = i;
				}
			} else {
				for (let i = targetLine + 1; i < lines.length; i++) {
					const lineIndent = (lines[i].match(/^\s*/)?.[0] || "").length;
					if (lineIndent <= startIndent && lines[i].trim().length > 0) {
						endLine = i - 1;
						break;
					}
					endLine = i;
				}
			}

			const newLines = params.newText.split("\n").map((l) => " ".repeat(startIndent) + l);
			lines.splice(targetLine, endLine - targetLine + 1, ...newLines);

			const { writeFileSync } = await import("node:fs");
			writeFileSync(absPath, lines.join("\n"), "utf-8");

			return {
				content: [{ type: "text", text: `Replaced symbol at L${targetLine + 1} (lines ${targetLine + 1}-${endLine + 1})` }],
				details: { startLine: targetLine + 1, endLine: endLine + 1 },
			};
		},
	});

	// ── Condense Tool ────────────────────────────────────────────────────

	pi.registerTool({
		name: "condense",
		label: "Condense",
		description: "Compact the current conversation context to free up token space",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			try {
				if (typeof ctx.compact === "function") {
					await ctx.compact();
					return {
						content: [{ type: "text", text: "Context condensed successfully" }],
						details: {},
					};
				}
				return {
					content: [{ type: "text", text: "Compaction not available in this mode" }],
					details: {},
				};
			} catch (error: any) {
				return {
					content: [{ type: "text", text: `Condense failed: ${error.message}` }],
					details: { error: error.message },
				};
			}
		},
	});

	// ── Diagnostics Scan Tool ────────────────────────────────────────────

	pi.registerTool({
		name: "diagnostics_scan",
		label: "Diagnostics Scan",
		description: "Run linter/type-checker on a file and return errors/warnings",
		parameters: Type.Object({
			path: Type.String({ description: "File path to scan" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const absPath = params.path.startsWith("/") ? params.path : pathResolve(ctx.cwd, params.path);
			const ext = absPath.split(".").pop();

			const commands: Record<string, string> = {
				ts: `npx typescript --noEmit --pretty false "${absPath}" 2>&1 || npx tsc --noEmit --pretty false "${absPath}" 2>&1 || true`,
				tsx: `npx typescript --noEmit --pretty false "${absPath}" 2>&1 || npx tsc --noEmit --pretty false "${absPath}" 2>&1 || true`,
				py: `python3 -m py_compile "${absPath}" 2>&1 || python3 -m flake8 "${absPath}" 2>&1 || true`,
			};

			const cmd = commands[ext || ""];
			if (!cmd) {
				return {
					content: [{ type: "text", text: `No linter configured for .${ext} files. Supported: .ts, .tsx, .py` }],
					details: {},
				};
			}

			const result = await pi.exec("bash", ["-c", cmd], { cwd: ctx.cwd });
			const output = (result.stdout || "") + (result.stderr || "");
			const outputLines = output.split("\n").filter((l) => l.trim()).slice(0, 50);

			return {
				content: [{ type: "text", text: outputLines.length > 0 ? outputLines.join("\n") : "No diagnostics found" }],
				details: { exitCode: result.exitCode, lines: outputLines.length },
			};
		},
	});
}
