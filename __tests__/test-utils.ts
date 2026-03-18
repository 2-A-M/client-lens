import type { LensClient } from "../src/client";
import type { LensPost, Profile } from "../src/types";

export function createMockPost(overrides: Partial<LensPost> = {}): LensPost {
    return {
        id: "test-post-id",
        content: "Test post content",
        author: { address: "0x1234567890abcdef1234567890abcdef12345678", username: "testuser" },
        commentOn: null,
        isDeleted: false,
        ...overrides,
    };
}

export function createMockProfile(overrides: Partial<Profile> = {}): Profile {
    return {
        address: "0x1234567890abcdef1234567890abcdef12345678",
        username: "testuser",
        name: "Test User",
        bio: "A test profile",
        pfp: null,
        ...overrides,
    };
}
