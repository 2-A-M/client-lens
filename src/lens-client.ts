/**
 * Lens V3 agent client — wires LensClient, PostManager, and InteractionManager.
 */

import {
    type IAgentRuntime,
} from "@elizaos/core";
import { LensClient } from "./client";
import { LensPostManager } from "./post";
import { LensInteractionManager } from "./interactions";

export class LensAgentClient {
    private client: LensClient;
    private posts: LensPostManager;
    private interactions: LensInteractionManager;
    private runtime: IAgentRuntime;

    constructor(runtime: IAgentRuntime) {
        this.runtime = runtime;

        const apiKey = runtime.getSetting("LENS_API_KEY");
        const accountAddress = runtime.getSetting("LENS_ACCOUNT_ADDRESS");
        const privateKey = runtime.getSetting("LENS_PRIVATE_KEY");
        const appAddress = runtime.getSetting("LENS_APP_ADDRESS");

        if (!apiKey || !accountAddress || !privateKey || !appAddress) {
            throw new Error(
                "[lens] Missing required settings: LENS_API_KEY, LENS_ACCOUNT_ADDRESS, LENS_PRIVATE_KEY, LENS_APP_ADDRESS"
            );
        }

        const cache = new Map<string, unknown>();

        this.client = new LensClient(runtime, cache, {
            apiKey: apiKey as string,
            appAddress: appAddress as string,
            accountAddress: accountAddress as string,
            privateKey: privateKey as string,
        });

        this.posts = new LensPostManager(
            this.client,
            runtime,
            accountAddress as string
        );
        this.interactions = new LensInteractionManager(
            this.client,
            runtime,
            accountAddress as string
        );
    }

    async start(): Promise<void> {
        const runtime = this.runtime;

        // Authenticate with Lens V3
        const ok = await this.client.authenticate();
        if (!ok) {
            runtime.logger.error(
                "[lens] Authentication failed — client will not start"
            );
            return;
        }

        // Load profile info
        const profile = await this.client.getProfile();
        if (profile) {
            this.client.accountUsername = profile.username;
            runtime.logger.info(
                `[lens] Logged in as ${profile.username ?? profile.address}`
            );
        }

        // Start post generation and interaction handling
        await this.posts.start();
        await this.interactions.start();

        runtime.logger.info("[lens] Client started");
    }

    async stop(): Promise<void> {
        await this.posts.stop();
        await this.interactions.stop();
        this.runtime.logger.info("[lens] Client stopped");
    }

    static async start(runtime: IAgentRuntime): Promise<LensAgentClient> {
        const client = new LensAgentClient(runtime);
        await client.start();
        return client;
    }
}
