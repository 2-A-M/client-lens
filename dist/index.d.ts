import { IAgentRuntime } from '@elizaos/core';

/**
 * Lens V3 agent client — wires LensClient, PostManager, and InteractionManager.
 */

declare class LensAgentClient {
    private client;
    private posts;
    private interactions;
    private runtime;
    constructor(runtime: IAgentRuntime);
    start(): Promise<void>;
    stop(): Promise<void>;
    static start(runtime: IAgentRuntime): Promise<LensAgentClient>;
}

/**
 * Lens Protocol V3 connector plugin for ElizaOS.
 *
 * Provides posting, mention handling, and interaction on Lens Protocol
 * using the V3 GraphQL API at api.lens.xyz.
 */
declare const lensPlugin: {
    name: string;
    description: string;
    clients: {
        start(runtime: unknown): Promise<LensAgentClient>;
    }[];
    actions: never[];
};

export { lensPlugin as default };
