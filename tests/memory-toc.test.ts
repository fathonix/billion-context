import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractTopicFromSummary, renderMemoryToc, resolveMemoryToc, type BlockTocItem } from "../src/memory-toc.js";

describe("memory-toc", () => {
    describe("extractTopicFromSummary", () => {
        it("returns untitled for empty or blank summary", () => {
            assert.equal(extractTopicFromSummary(""), "(untitled)");
            assert.equal(extractTopicFromSummary("   \n\n  "), "(untitled)");
        });

        it("extracts topic from standard header line [Compressed conversation section] — <topic>", () => {
            const summary = "[Compressed conversation section] — Headroom compose migration & opencode discovery fix\n\n### Overall Goal\nMigrated headroom.";
            assert.equal(extractTopicFromSummary(summary), "Headroom compose migration & opencode discovery fix");
        });

        it("extracts topic with hyphen or en-dash delimiter", () => {
            const summary = "[Compressed conversation section] - opencode prompt reduction and v2 plugin research\nDetails here";
            assert.equal(extractTopicFromSummary(summary), "opencode prompt reduction and v2 plugin research");
        });

        it("falls back to markdown heading when header line is missing", () => {
            const summary = "### Upstream PR #65 Submission & Verification\n- PR was submitted cleanly.";
            assert.equal(extractTopicFromSummary(summary), "Upstream PR #65 Submission & Verification");
        });

        it("falls back to first non-boilerplate line when no headings exist", () => {
            const summary = "- Fixed bug in database connection string for local dev\n- Verified port forwarding";
            assert.equal(extractTopicFromSummary(summary), "Fixed bug in database connection string for local dev");
        });
    });

    describe("renderMemoryToc", () => {
        it("returns null when blocks array is empty or undefined", () => {
            assert.equal(renderMemoryToc(undefined), null);
            assert.equal(renderMemoryToc([]), null);
        });

        it("returns null when all blocks are inactive", () => {
            const blocks: BlockTocItem[] = [
                { blockId: "b1", active: false, summary: "summary 1" },
                { blockId: "b2", active: false, summary: "summary 2" },
            ];
            assert.equal(renderMemoryToc(blocks), null);
        });

        it("renders active blocks with topics and tier labels", () => {
            const blocks: BlockTocItem[] = [
                { blockId: "b1", active: false, summary: "old folded" },
                { blockId: "b2", active: true, topic: "MariaDB migration and tests", summary: "..." },
                { blockId: "b3", active: true, summary: "[Compressed conversation section] — Opencode v2 binary investigation\n..." },
                { blockId: "b4", active: true, tier: 2, topic: "Rollup of auth & model routing", summary: "..." },
            ];

            const toc = renderMemoryToc(blocks);
            assert.ok(toc !== null);
            assert.ok(toc.includes("### Active Session Memory Index"));
            assert.ok(toc.includes("- b2: MariaDB migration and tests"));
            assert.ok(toc.includes("- b3: Opencode v2 binary investigation"));
            assert.ok(toc.includes("- b4 (T2): Rollup of auth & model routing"));
            assert.ok(!toc.includes("b1")); // Inactive block omitted
        });

        it("respects maxBlocks option and prepends overflow note", () => {
            const blocks: BlockTocItem[] = [
                { blockId: "b1", active: true, topic: "Topic 1", summary: "" },
                { blockId: "b2", active: true, topic: "Topic 2", summary: "" },
                { blockId: "b3", active: true, topic: "Topic 3", summary: "" },
            ];

            const toc = renderMemoryToc(blocks, { maxBlocks: 2 });
            assert.ok(toc !== null);
            assert.ok(toc.includes("... and 1 earlier block(s)"));
            assert.ok(!toc.includes("- b1:"));
            assert.ok(toc.includes("- b2: Topic 2"));
            assert.ok(toc.includes("- b3: Topic 3"));
        });
    });

    describe("resolveMemoryToc", () => {
        it("respects env BILI_MEMORY_TOC overrides", () => {
            assert.equal(resolveMemoryToc({ BILI_MEMORY_TOC: "0" }, true), false);
            assert.equal(resolveMemoryToc({ BILI_MEMORY_TOC: "false" }, true), false);
            assert.equal(resolveMemoryToc({ BILI_MEMORY_TOC: "off" }, true), false);
            assert.equal(resolveMemoryToc({ BILI_MEMORY_TOC: "1" }, false), true);
            assert.equal(resolveMemoryToc({ BILI_MEMORY_TOC: "true" }, false), true);
        });

        it("defaults to file value or true", () => {
            assert.equal(resolveMemoryToc({}, false), false);
            assert.equal(resolveMemoryToc({}, true), true);
            assert.equal(resolveMemoryToc({}, undefined), true);
        });
    });
});
