export const ANCHOR_DELIMITER = "§";

export function stripAnchorPrefix(line: string, offset = 0): string {
	const delimiterIndex = line.indexOf(ANCHOR_DELIMITER, offset);
	if (delimiterIndex === -1) return line;
	const prefix = line.substring(offset, delimiterIndex);
	if (!/^[A-Z][a-zA-Z0-9_]*$/.test(prefix)) return line;
	return line.substring(0, offset) + line.substring(delimiterIndex + ANCHOR_DELIMITER.length);
}

export function stripHashes(content: string): string {
	if (!content) return "";
	return content.split("\n").map((line) => stripAnchorPrefix(line)).join("\n");
}

export function stripHashesFromDiff(content: string): string {
	if (!content) return "";
	return content
		.split("\n")
		.map((line) => {
			if (line.length > 0 && (line[0] === "+" || line[0] === "-" || line[0] === " ")) {
				return stripAnchorPrefix(line, 1);
			}
			return stripAnchorPrefix(line);
		})
		.join("\n");
}

export function extractId(ref: string): string {
	if (!ref) return "";
	const delimiterIndex = ref.indexOf(ANCHOR_DELIMITER);
	return delimiterIndex === -1 ? ref : ref.substring(0, delimiterIndex);
}

export function annotateLinesWithAnchors(content: string, filePath: string): string {
	const lines = content.split("\n");
	const ext = filePath.split(".").pop() || "";

	return lines
		.map((line, i) => {
			const trimmed = line.trimStart();
			let symbolName = "";

			if (["ts", "tsx", "js", "jsx"].includes(ext)) {
				const m = trimmed.match(
					/^(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
				);
				if (m) symbolName = m[1];
			} else if (ext === "py") {
				const m = trimmed.match(/^(?:def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/);
				if (m) symbolName = m[1];
			} else if (ext === "go") {
				const m = trimmed.match(/^func\s+(?:\([^)]+\)\s+)?([A-Za-z_][A-Za-z0-9_]*)/);
				if (m) symbolName = m[1];
			} else if (ext === "rs") {
				const m = trimmed.match(/^(?:pub\s+)?(?:async\s+)?(?:fn|struct|enum|trait|impl)\s+([A-Za-z_][A-Za-z0-9_]*)/);
				if (m) symbolName = m[1];
			} else if (["c", "cpp", "cc", "h", "hpp"].includes(ext)) {
				const m = trimmed.match(/^(?:[\w:*&]+\s+)+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
				if (m) symbolName = m[1];
			} else if (["java", "kt"].includes(ext)) {
				const m = trimmed.match(/(?:public|private|protected|static|async|fun|override)*\s*(?:fun|function|def|function)\s+([A-Za-z_][A-Za-z0-9_]*)/);
				if (m) symbolName = m[1];
			} else if (ext === "rb") {
				const m = trimmed.match(/^(?:def|class|module)\s+([A-Za-z_][A-Za-z0-9_]*[?!]?)/);
				if (m) symbolName = m[1];
			} else if (ext === "php") {
				const m = trimmed.match(/(?:public|private|protected|static)\s+(?:function)\s+([A-Za-z_][A-Za-z0-9_]*)/);
				if (m) symbolName = m[1];
			} else if (ext === "swift") {
				const m = trimmed.match(/(?:func|class|struct|enum|protocol)\s+([A-Za-z_][A-Za-z0-9_]*)/);
				if (m) symbolName = m[1];
			} else if (ext === "zig") {
				const m = trimmed.match(/(?:pub\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/);
				if (m) symbolName = m[1];
			}

			const anchor = symbolName ? `${symbolName}${ANCHOR_DELIMITER}` : `${i + 1}${ANCHOR_DELIMITER}`;
			return `${anchor}${line}`;
		})
		.join("\n");
}

export function resolveLineRef(lineRef: string, fileContent: string): string | null {
	const lines = fileContent.split("\n");
	const id = extractId(lineRef);

	const numericId = Number.parseInt(id, 10);
	if (!Number.isNaN(numericId) && numericId >= 1 && numericId <= lines.length) {
		return lines[numericId - 1];
	}

	for (const line of lines) {
		if (line.startsWith(id + ANCHOR_DELIMITER)) {
			return line.substring(id.length + ANCHOR_DELIMITER.length);
		}
	}

	return null;
}

export const anchorState = new Map<string, string>();
