/**
 * Lens V3 autonomous post generation — periodically creates new posts.
 */

import {
    composePrompt,
    type IAgentRuntime,
    ModelType,
    stringToUuid,
} from "@elizaos/core";
import type { LensClient } from "./client";
import { formatTimeline, postTemplate } from "./prompts";
import { sendPublication } from "./actions";

export class LensPostManager {
    private client: LensClient;
    private runtime: IAgentRuntime;
    private accountAddress: string;
    private dryRun: boolean;
    private postTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(
        client: LensClient,
        runtime: IAgentRuntime,
        accountAddress: string
    ) {
        this.client = client;
        this.runtime = runtime;
        this.accountAddress = accountAddress;
        this.dryRun = runtime.getSetting("LENS_DRY_RUN") === "true";
    }

    async start(): Promise<void> {
        await this.generateNewPublication();
        this.scheduleNext();
    }

    async stop(): Promise<void> {
        if (this.postTimer) {
            clearTimeout(this.postTimer);
            this.postTimer = null;
        }
    }

    private scheduleNext(): void {
        // Random interval between 1–4 hours
        const minMs = 60 * 60 * 1000;
        const maxMs = 4 * 60 * 60 * 1000;
        const delay = Math.floor(Math.random() * (maxMs - minMs)) + minMs;

        this.runtime.logger.info(
            `[lens] Next post in ${Math.round(delay / 60000)} minutes`
        );

        this.postTimer = setTimeout(async () => {
            await this.generateNewPublication();
            this.scheduleNext();
        }, delay);
    }

    private async generateNewPublication(): Promise<void> {
        try {
            const runtime = this.runtime;

            // Get profile and timeline for context
            const profile = await this.client.getProfile();
            const timeline = await this.client.getTimeline();
            const formattedTimeline = formatTimeline(
                runtime.character,
                timeline
            );

            // Get recent posts to avoid repetition
            const recentPosts = await this.client.getPublicationsFor(
                this.accountAddress,
                10
            );
            const recentPostsText = recentPosts
                .map((p) => p.content)
                .join("\n");

            const roomId = stringToUuid(`lens-post-${this.accountAddress}`);

            // Pick random topic and adjective from character
            const topics = runtime.character.topics ?? [];
            const topic =
                topics[Math.floor(Math.random() * topics.length)] ??
                "something interesting";
            const adjectives = runtime.character.adjectives ?? [];
            const adjective =
                adjectives[
                    Math.floor(Math.random() * adjectives.length)
                ] ?? "thought-provoking";

            const state = await runtime.composeState(
                {
                    entityId: runtime.agentId,
                    agentId: runtime.agentId,
                    roomId,
                    content: { text: "", source: "lens" },
                } as unknown as import("@elizaos/core").Memory,
                {
                    lensHandle:
                        profile?.username ?? this.accountAddress,
                    timeline: formattedTimeline,
                    recentPosts: recentPostsText,
                    topic,
                    adjective,
                }
            );

            const context = composePrompt({
                state,
                template: postTemplate,
            });

            const result = await runtime.useModel(ModelType.TEXT_SMALL, {
                prompt: context,
            });
            const text = typeof result === "string"
                ? result
                : (result as { text?: string })?.text ?? "";

            if (!text?.trim()) {
                runtime.logger.debug("[lens] No post text generated");
                return;
            }

            // Clean up the generated text
            const cleanText = text
                .replace(/^["']|["']$/g, "")
                .trim();

            await sendPublication({
                client: this.client,
                runtime,
                content: cleanText,
                roomId: roomId as string,
                dryRun: this.dryRun,
            });

            runtime.logger.info(
                `[lens] Generated post: ${cleanText.substring(0, 80)}...`
            );
        } catch (err) {
            this.runtime.logger.error(
                `[lens] Error generating post: ${err}`
            );
        }
    }
}
