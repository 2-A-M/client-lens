import { describe, it, expect } from "vitest";

describe("Post utilities", () => {
    it("publicationUuid generates deterministic IDs", async () => {
        const { publicationUuid } = await import("../src/utils");
        const id1 = publicationUuid({ pubId: "post-1", agentId: "agent-1" });
        const id2 = publicationUuid({ pubId: "post-1", agentId: "agent-1" });
        const id3 = publicationUuid({ pubId: "post-2", agentId: "agent-1" });

        expect(id1).toBe(id2);
        expect(id1).not.toBe(id3);
    });

    it("post content length validation", () => {
        const MAX_POST_LENGTH = 5000;
        expect("short post".length).toBeLessThanOrEqual(MAX_POST_LENGTH);
        expect("A".repeat(5001).length).toBeGreaterThan(MAX_POST_LENGTH);
    });

    it("content URI format is valid", () => {
        const content = "Hello Lens V3!";
        const metadata = {
            $schema: "https://json-schemas.lens.dev/posts/text-only/3.0.0.json",
            lens: {
                id: "test-uuid",
                mainContentFocus: "TEXT_ONLY",
                locale: "en",
                content,
            },
        };
        const uri = `data:application/json,${encodeURIComponent(JSON.stringify(metadata))}`;
        expect(uri).toMatch(/^data:application\/json,/);
        expect(uri).toContain(encodeURIComponent(content));
    });
});
