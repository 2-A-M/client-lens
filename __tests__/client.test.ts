import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

describe("LensClient", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe("GraphQL transport", () => {
        it("sends correct headers with API key", async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({ data: { account: null } }),
            });

            const { LensClient } = await import("../src/client");
            const mockRuntime = {
                logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
                getSetting: vi.fn(),
                agentId: "test-agent",
            };

            const client = new LensClient(mockRuntime as any, new Map(), {
                apiKey: "test-api-key",
                appAddress: "0xapp",
                accountAddress: "0xaccount",
                privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
            });

            await client.getProfile("0xtest");

            expect(mockFetch).toHaveBeenCalled();
            const [url, opts] = mockFetch.mock.calls[0];
            expect(url).toBe("https://api.lens.xyz/graphql");
            expect(opts.headers["x-api-key"]).toBe("test-api-key");
            expect(opts.headers["Content-Type"]).toBe("application/json");
        });
    });

    describe("createPublication", () => {
        it("rejects content over 5000 chars", async () => {
            const { LensClient } = await import("../src/client");
            const mockRuntime = {
                logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
            };

            const client = new LensClient(mockRuntime as any, new Map(), {
                apiKey: "key",
                appAddress: "0xapp",
                accountAddress: "0xaccount",
                privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
            });

            const result = await client.createPublication("A".repeat(5001));
            expect(result.hash).toBeNull();
            expect(result.error).toContain("5000");
        });

        it("sends correct mutation for text post", async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    data: { post: { hash: "0xabc123" } },
                }),
            });

            const { LensClient } = await import("../src/client");
            const mockRuntime = {
                logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
            };

            const client = new LensClient(mockRuntime as any, new Map(), {
                apiKey: "key",
                appAddress: "0xapp",
                accountAddress: "0xaccount",
                privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
            });
            // Set authenticated state
            (client as any).accessToken = "test-token";
            client.authenticated = true;

            const result = await client.createPublication("Hello Lens V3!");
            expect(result.hash).toBe("0xabc123");
        });
    });

    describe("getProfile", () => {
        it("returns profile from API response", async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    data: {
                        account: {
                            address: "0xtest",
                            username: { localName: "testuser" },
                            metadata: { name: "Test", bio: "Bio", picture: null },
                        },
                    },
                }),
            });

            const { LensClient } = await import("../src/client");
            const mockRuntime = {
                logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
            };

            const client = new LensClient(mockRuntime as any, new Map(), {
                apiKey: "key",
                appAddress: "0xapp",
                accountAddress: "0xaccount",
                privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
            });

            const profile = await client.getProfile("0xtest");
            expect(profile).not.toBeNull();
            expect(profile?.username).toBe("testuser");
            expect(profile?.address).toBe("0xtest");
        });

        it("returns null for non-existent profile", async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({ data: { account: null } }),
            });

            const { LensClient } = await import("../src/client");
            const mockRuntime = {
                logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
            };

            const client = new LensClient(mockRuntime as any, new Map(), {
                apiKey: "key",
                appAddress: "0xapp",
                accountAddress: "0xaccount",
                privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
            });

            const profile = await client.getProfile("0xnonexistent");
            expect(profile).toBeNull();
        });

        it("caches profile results", async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    data: {
                        account: {
                            address: "0xcached",
                            username: { localName: "cached" },
                            metadata: {},
                        },
                    },
                }),
            });

            const { LensClient } = await import("../src/client");
            const mockRuntime = {
                logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
            };

            const client = new LensClient(mockRuntime as any, new Map(), {
                apiKey: "key",
                appAddress: "0xapp",
                accountAddress: "0xaccount",
                privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
            });

            await client.getProfile("0xcached");
            await client.getProfile("0xcached");

            // Only one fetch call — second was served from cache
            expect(mockFetch).toHaveBeenCalledTimes(1);
        });
    });
});
