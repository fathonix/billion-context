/**
 * #memory-toc: Session Memory Table of Contents (TOC).
 * Compact, single-line index of active compression blocks injected into
 * the system context so the model always knows what past milestones exist
 * in memory without having to search blind or re-read long summaries.
 */

export interface BlockTocItem {
    blockId: string;
    active?: boolean;
    topic?: string;
    summary?: string;
    tier?: number;
    effectiveMessageIds?: readonly string[];
}

export interface RenderTocOptions {
    /** Max number of recent blocks to list (default: 100). */
    maxBlocks?: number;
    /** Custom heading text. */
    header?: string;
}

/**
 * Extract a concise topic from block.summary if block.topic is unset.
 */
export function extractTopicFromSummary(summary: string): string {
    if (!summary) return "(untitled)";
    
    // 1. Check for [Compressed conversation section] — <topic>
    const headerMatch = /^(?:\[Compressed conversation section\]\s*[—–-]\s*)([^\n]+)/m.exec(summary);
    if (headerMatch && headerMatch[1]?.trim()) {
        return headerMatch[1].trim();
    }
    
    // 2. Check for markdown headings: ### Topic or ## Topic or # Topic
    const headingMatch = /^\s*#{1,4}\s+([^\n]+)/m.exec(summary);
    if (headingMatch && headingMatch[1]?.trim()) {
        const text = headingMatch[1].trim();
        // Skip generic boilerplate headings if possible
        if (!/^Overall Goal/i.test(text) && !/^Context/i.test(text) && text.length > 3) {
            return text;
        }
    }
    
    // 3. Fallback: first non-empty line without markdown bullets
    const lines = summary.split("\n").map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
        const clean = line.replace(/^[-*•#\s]+/, "").trim();
        if (clean.length > 5 && !clean.startsWith("[") && !clean.startsWith("TASK AS OF")) {
            return clean.length > 70 ? clean.slice(0, 67) + "..." : clean;
        }
    }
    return "(untitled)";
}

/**
 * Render a high-density, one-line-per-block index of active blocks.
 * Returns null if no active blocks exist.
 */
export function renderMemoryToc(
    blocks: readonly BlockTocItem[] | undefined,
    options: RenderTocOptions = {},
): string | null {
    if (!blocks || blocks.length === 0) return null;
    const active = blocks.filter((b) => b.active !== false);
    if (active.length === 0) return null;

    const maxBlocks = options.maxBlocks ?? 100;
    const displayed = active.slice(-maxBlocks);
    const lines: string[] = [];

    for (const b of displayed) {
        const rawTopic = (b.topic && b.topic.trim()) ? b.topic.trim() : extractTopicFromSummary(b.summary ?? "");
        const topic = rawTopic.replace(/[\r\n]+/g, " ").trim();
        const tier = typeof b.tier === "number" && b.tier > 1 ? ` (T${b.tier})` : "";
        lines.push(`- ${b.blockId}${tier}: ${topic}`);
    }

    if (active.length > maxBlocks) {
        lines.unshift(`... and ${active.length - maxBlocks} earlier block(s)`);
    }

    const header = options.header ?? "### Active Session Memory Index\nCompressed milestones in this session (call search_context({ query }) or decompress({ blockId }) to inspect details):";
    return `${header}\n${lines.join("\n")}`;
}

/**
 * Knob resolver for Memory TOC:
 * Env BILI_MEMORY_TOC wins over config file setting.
 * Defaults to true if not explicitly disabled.
 */
export function resolveMemoryToc(env: NodeJS.ProcessEnv = process.env, fileValue?: boolean): boolean {
    const raw = env.BILI_MEMORY_TOC?.trim().toLowerCase();
    if (raw === "0" || raw === "false" || raw === "off") return false;
    if (raw === "1" || raw === "true" || raw === "on") return true;
    return typeof fileValue === "boolean" ? fileValue : true;
}
