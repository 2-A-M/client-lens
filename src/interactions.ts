/**
 * Lens V3 interaction manager — polls for mentions and generates replies.
 */

import {
    composePrompt,
    type Memory,
    type IAgentRuntime,
    stringToUuid,
    ModelType,
} from "@elizaos/core";
import type { LensClient } from "./client";
import {
    formatPublication,
    formatTimeline,
    messageHandlerTemplate,
    shouldRespondTemplate,
} from "./prompts";
import { buildConversationThread, createPublicationMemory } from "./memory";
import { sendPublication } from "./actions";
import { publicationUuid } from "./utils";

export class LensInteractionManager {
    private client: LensClient;
    private runtime: IAgentRuntime;
    private accountAddress: string;
    private pollInterval: number;
    private dryRun: boolean;
    private seenNotificationIds = new Set<string>();
    private pollTimer: ReturnType<typeof setInterval> | null = null;

    constructor(
        client: LensClient,
        runtime: IAgentRuntime,
        accountAddress: string
    ) {
        this.client = client;
        this.runtime = runtime;
        this.accountAddress = accountAddress;

        const interval = runtime.getSetting("LENS_POLL_INTERVAL");
        const parsed = typeof interval === "string" ? parseInt(interval, 10) : NaN;
        this.pollInterval = (Number.isFinite(parsed) && parsed > 0 ? parsed : 120) * 1000;

        this.dryRun = runtime.getSetting("LENS_DRY_RUN") === "true";
    }

    async start(): Promise<void> {
        await this.handleInteractions();
        this.pollTimer = setInterval(
            () => this.handleInteractions(),
            this.pollInterval
        );
    }

    async stop(): Promise<void> {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
    }

    private async handleInteractions(): Promise<void> {
        try {
            const mentions = await this.client.getMentions();

            for (const mention of mentions) {
                // Skip already-processed notifications
                if (this.seenNotificationIds.has(mention.id)) continue;
                this.seenNotificationIds.add(mention.id);

                const post = mention.post;

                // Skip own posts
                if (
                    post.author.address.toLowerCase() ===
                    this.accountAddress.toLowerCase()
                ) {
                    continue;
                }

                // Check if already processed via memory
                const memoryId = stringToUuid(
                    publicationUuid({
                        pubId: post.id,
                        agentId: this.runtime.agentId as string,
                    })
                );
                const exists =
                    await this.runtime.getMemoryById(memoryId);
                if (exists) continue;

                await this.handleMention(post);
            }

            // Prevent unbounded Set growth — keep only recent IDs
            if (this.seenNotificationIds.size > 1000) {
                const ids = Array.from(this.seenNotificationIds);
                this.seenNotificationIds = new Set(ids.slice(-500));
            }
        } catch (err) {
            this.runtime.logger.error(
                `[lens] Error handling interactions: ${err}`
            );
        }
    }

    private async handleMention(post: {
        id: string;
        content: string;
        author: { address: string; username?: string };
    }): Promise<void> {
        const runtime = this.runtime;
        const roomId = stringToUuid(`lens-room-${post.id}`);

        // Build conversation thread
        const fullPost = await this.client.getPublication(post.id);
        if (!fullPost) return;

        const thread = await buildConversationThread({
            post: fullPost,
            client: this.client,
            runtime,
            agentId: runtime.agentId as string,
            roomId: roomId as string,
        });

        const formattedConversation = thread
            .map(formatPublication)
            .join("\n\n");

        // Get timeline for context
        const timeline = await this.client.getTimeline();
        const formattedTimeline = formatTimeline(
            runtime.character,
            timeline
        );

        // Save the mention as memory
        const memory = createPublicationMemory({
            post: fullPost,
            agentId: runtime.agentId as string,
            roomId: roomId as string,
        });
        await runtime.createMemory(memory, "messages");

        // Compose context
        const state = await runtime.composeState(memory, {
            lensHandle: this.client.accountUsername ?? this.accountAddress,
            timeline: formattedTimeline,
            formattedConversation,
            currentPost: `From: @${post.author.username ?? post.author.address}\n${post.content}`,
        });

        // Should we respond?
        const shouldRespondContext = composePrompt({
            state,
            template: shouldRespondTemplate,
        });

        // Use runtime.useModel for v2 compatibility
        const shouldRespondResult = await runtime.useModel(ModelType.TEXT_SMALL, {
            prompt: shouldRespondContext,
        });
        const shouldRespondText = typeof shouldRespondResult === "string"
            ? shouldRespondResult
            : (shouldRespondResult as { text?: string })?.text ?? "";
        const shouldRespond = shouldRespondText.includes("RESPOND")
            ? "RESPOND"
            : shouldRespondText.includes("STOP")
              ? "STOP"
              : "IGNORE";

        if (shouldRespond !== "RESPOND") {
            runtime.logger.debug(
                `[lens] Decided not to respond to ${post.id}: ${shouldRespond}`
            );
            return;
        }

        // Generate reply
        const responseContext = composePrompt({
            state,
            template: messageHandlerTemplate,
        });

        const responseResult = await runtime.useModel(ModelType.TEXT_LARGE, {
            prompt: responseContext,
        });
        const response = typeof responseResult === "string"
            ? { text: responseResult }
            : (responseResult as { text?: string }) ?? { text: "" };

        if (!response?.text) {
            runtime.logger.debug(`[lens] No response generated for ${post.id}`);
            return;
        }

        // Post reply
        await sendPublication({
            client: this.client,
            runtime,
            content: response.text,
            roomId: roomId as string,
            commentOn: post.id,
            dryRun: this.dryRun,
        });

        runtime.logger.info(
            `[lens] Replied to ${post.id}: ${response.text.substring(0, 80)}...`
        );
    }
}
