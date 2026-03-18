/**
 * Lens Protocol V3 connector plugin for ElizaOS.
 *
 * Provides posting, mention handling, and interaction on Lens Protocol
 * using the V3 GraphQL API at api.lens.xyz.
 */

const lensPlugin = {
    name: "lens",
    description: "Lens Protocol V3 connector for posting and receiving on Lens",
    clients: [
        {
            async start(runtime: unknown) {
                const { LensAgentClient } = await import("./lens-client");
                return LensAgentClient.start(
                    runtime as import("@elizaos/core").IAgentRuntime
                );
            },
        },
    ],
    actions: [],
};

export default lensPlugin;
