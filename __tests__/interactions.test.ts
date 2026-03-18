import { describe, it, expect } from "vitest";
import { createMockPost, createMockProfile } from "./test-utils";

describe("Interactions", () => {
    describe("createMockPost", () => {
        it("creates a post with default values", () => {
            const post = createMockPost();
            expect(post.id).toBe("test-post-id");
            expect(post.content).toBe("Test post content");
            expect(post.author.address).toBeDefined();
            expect(post.isDeleted).toBe(false);
        });

        it("accepts overrides", () => {
            const post = createMockPost({ content: "Custom content", isDeleted: true });
            expect(post.content).toBe("Custom content");
            expect(post.isDeleted).toBe(true);
        });

        it("handles commentOn field", () => {
            const post = createMockPost({ commentOn: { id: "parent-id" } });
            expect(post.commentOn?.id).toBe("parent-id");
        });
    });

    describe("createMockProfile", () => {
        it("creates a profile with default values", () => {
            const profile = createMockProfile();
            expect(profile.address).toBeDefined();
            expect(profile.username).toBe("testuser");
        });

        it("accepts overrides", () => {
            const profile = createMockProfile({ username: "custom" });
            expect(profile.username).toBe("custom");
        });
    });
});
