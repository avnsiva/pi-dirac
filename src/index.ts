/**
 * pi-dirac: Dirac's best features for Pi
 *
 * - Hash-anchored edits (intercept read/edit via tool_call hooks)
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
	stripHashes,
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
When editing, prefer using \`lineRef\` in the edit tool:
\`{ "path": "file.ts", "lineRef": "MyFunction§    return x + 1;", "newText": "    return x + 2;" }\`
This is more reliable than copying exact text. Always prefer lineRef when anchors are visible.`;

		if (!event.systemPrompt.includes("Hash-Anchored Edit Mode")) {
			return { systemPrompt: event.systemPrompt + hashInstructions };
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "read") {
			const input = event.input as any;
			const filePath = input.path;
			const absPath = filePath.startsWith("/") ? filePath : pathResolve(ctx.cwd, filePath);

			try {
				const content = readFileSync(absPath, "utf-8");
				const annotated = annotateLinesWithAnchors(content, absPath);
				anchorState.set(absPath, content);
				input._piDiracAnnotated = annotated;
			} catch {}
		}

		if (event.toolName === "edit") {
			const input = event.input as any;
			if (input.lineRef) {
				const filePath = input.path;
				const absPath = filePath.startsWith("/") ? filePath : pathResolve(ctx.cwd, filePath);

				let fileContent = anchorState.get(absPath);
				if (!fileContent) {
					try {
						fileContent = readFileSync(absPath, "utf-8");
					} catch {
						return { block: true, reason: `Cannot read file: ${filePath}` };
					}
				}

				const resolved = resolveLineRef(input.lineRef, fileContent);
				if (!resolved) {
					return { block: true, reason: `Could not resolve lineRef: ${input.lineRef}` };
				}

				input.oldText = resolved;
				if (!input.newText) input.newText = "";
				delete input.lineRef;
			}
		}
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

			const content = readFileSync(absPath, "utf-8");
			const lines = content.split("\n");
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

			const startLine = target.lineIndex;
			let endLine = startLine;
			const indent = target.indentation.length;

			for (let i = startLine + 1; i < lines.length; i++) {
				const lineIndent = (lines[i].match(/^\s*/)?.[0] || "").length;
				if (lineIndent <= indent && lines[i].trim().length > 0) {
					break;
				}
				endLine = i;
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

			const newContent = edited.join("\n");
			const { writeFileSync } = await import("node:fs");
			writeFileSync(absPath, newContent, "utf-8");

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
		description: "Replace a function/class body at a specific line using AST-aware anchoring",
		parameters: Type.Object({
			path: Type.String({ description: "File path" }),
			lineRef: Type.String({ description: "Hash-anchored line reference (e.g., MyFunction§    return x;)" }),
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
			} else {
				for (let i = 0; i < lines.length; i++) {
					if (lines[i].startsWith(id + ANCHOR_DELIMITER)) {
						targetLine = i;
						break;
					}
				}
			}

			if (targetLine === -1) {
				return {
					content: [{ type: "text", text: `Could not resolve lineRef: ${params.lineRef}` }],
					details: {},
				};
			}

			const indent = (lines[targetLine].match(/^\s*/)?.[0] || "").length;
			let endLine = targetLine;
			for (let i = targetLine + 1; i < lines.length; i++) {
				const lineIndent = (lines[i].match(/^\s*/)?.[0] || "").length;
				if (lineIndent <= indent && lines[i].trim().length > 0) break;
				endLine = i;
			}

			const newLines = params.newText.split("\n").map((l) => " ".repeat(indent) + l);
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
				await ctx.compact();
				const usage = ctx.getContextUsage();
				return {
					content: [{ type: "text", text: `Context condensed. Usage: ${Math.round(usage.totalTokens / 1000)}k tokens` }],
					details: { tokens: usage.totalTokens },
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
				ts: `npx tsc --noEmit --pretty false "${absPath}" 2>&1 || true`,
				tsx: `npx tsc --noEmit --pretty false "${absPath}" 2>&1 || true`,
				js: `npx eslint "${absPath}" --format compact 2>&1 || true`,
				jsx: `npx eslint "${absPath}" --format compact 2>&1 || true`,
				py: `python -m py_compile "${absPath}" 2>&1 || python -m flake8 "${absPath}" 2>&1 || true`,
			};

			const cmd = commands[ext || ""];
			if (!cmd) {
				return {
					content: [{ type: "text", text: `No linter configured for .${ext} files` }],
					details: {},
				};
			}

			const result = await pi.exec("bash", ["-c", cmd], { cwd: ctx.cwd });
			const output = result.stdout + result.stderr;
			const lines = output.split("\n").filter((l) => l.trim()).slice(0, 50);

			return {
				content: [{ type: "text", text: lines.length > 0 ? lines.join("\n") : "No diagnostics found" }],
				details: { exitCode: result.exitCode, lines: lines.length },
			};
		},
	});
}
