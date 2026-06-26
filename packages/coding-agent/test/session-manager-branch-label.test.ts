/**
 * Unit tests for SessionManager.getCurrentBranchLabel().
 *
 * getCurrentBranchLabel walks from the current leaf up the parentId chain
 * and returns the nearest labeled entry on the current branch (the "branch
 * tag"), or undefined when no ancestor (including the leaf) is labeled.
 */

import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";

function userMsg(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

describe("SessionManager.getCurrentBranchLabel", () => {
	it("returns undefined when no entries are labeled", () => {
		const mgr = SessionManager.inMemory(tmpdir());
		const id = mgr.appendMessage(userMsg("hello"));
		mgr.appendLabelChange(id, undefined); // no-op label clear, ensures label path exercised
		expect(mgr.getCurrentBranchLabel()).toBeUndefined();
	});

	it("returns the leaf's own label when the leaf is labeled", () => {
		const mgr = SessionManager.inMemory(tmpdir());
		const id = mgr.appendMessage(userMsg("hello"));
		mgr.appendLabelChange(id, "leaf-tag");
		expect(mgr.getCurrentBranchLabel()).toBe("leaf-tag");
	});

	it("returns the nearest labeled ancestor when the leaf is unlabeled", () => {
		const mgr = SessionManager.inMemory(tmpdir());
		const rootId = mgr.appendMessage(userMsg("root"));
		mgr.appendLabelChange(rootId, "branch-tag");
		mgr.appendMessage(userMsg("child")); // leaf, unlabeled
		expect(mgr.getCurrentBranchLabel()).toBe("branch-tag");
	});

	it("returns the label of whichever branch the leaf is currently on", () => {
		const mgr = SessionManager.inMemory(tmpdir());
		const a = mgr.appendMessage(userMsg("a"));
		const b = mgr.appendMessage(userMsg("b")); // branch 1 leaf
		mgr.appendLabelChange(b, "branch1");

		// Branch back to `a` and create a second branch.
		mgr.branch(a);
		const c = mgr.appendMessage(userMsg("c")); // branch 2 leaf
		mgr.appendLabelChange(c, "branch2");

		// Currently on branch 2.
		expect(mgr.getCurrentBranchLabel()).toBe("branch2");

		// Move leaf back to branch 1's node.
		mgr.branch(b);
		expect(mgr.getCurrentBranchLabel()).toBe("branch1");
	});
});
