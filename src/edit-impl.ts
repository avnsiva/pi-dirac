import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

interface EditParams {
	path: string;
	edits: Array<{ oldText?: string; newText: string; lineRef?: string }>;
}

export async function editFile(
	params: EditParams,
	ctx: { cwd: string },
): Promise<{ content: Array<{ type: "text"; text: string }>; details: any }> {
	const filePath = params.path;
	const absPath = filePath.startsWith("/") ? filePath : filePath;

	let content: string;
	try {
		content = readFileSync(absPath, "utf-8");
	} catch (error: any) {
		return {
			content: [{ type: "text", text: `Error reading file: ${error.message}` }],
			details: { error: error.message },
		};
	}

	let appliedCount = 0;
	const errors: string[] = [];

	for (const edit of params.edits) {
		const oldText = edit.oldText;
		const newText = edit.newText;

		if (!oldText) {
			errors.push("Edit missing oldText (lineRef may not have resolved)");
			continue;
		}

		if (!content.includes(oldText)) {
			errors.push(`Could not find text: "${oldText.substring(0, 80)}..."`);
			continue;
		}

		// Replace first occurrence
		content = content.replace(oldText, newText);
		appliedCount++;
	}

	if (appliedCount > 0) {
		try {
			const dir = dirname(absPath);
			mkdirSync(dir, { recursive: true });
			writeFileSync(absPath, content, "utf-8");
		} catch (error: any) {
			return {
				content: [{ type: "text", text: `Error writing file: ${error.message}` }],
				details: { error: error.message },
			};
		}
	}

	const message =
		errors.length > 0
			? `Applied ${appliedCount}/${params.edits.length} edits. Errors: ${errors.join("; ")}`
			: `Successfully applied ${appliedCount} edit(s) to ${filePath}`;

	return {
		content: [{ type: "text", text: message }],
		details: { applied: appliedCount, total: params.edits.length, errors },
	};
}
