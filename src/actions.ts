/**
 * Publication creation for Lens V3.
 *
 * Posts use data: URIs with JSON metadata — no IPFS pinning needed for text.
 */

import type { LensClient } from "./client";
import type { Content, IAgentRuntime, Memory } from "@elizaos/core";
import { stringToUuid } from "@elizaos/core";
import type { LensPost } from "./types";

export async function sendPublication(opts: {
    client: LensClient;
    runtime: IAgentRuntime;
    content: string;
    roomId: string;
    commentOn?: string;
    dryRun?: boolean;
}): Promise<{ post: LensPost | null; memory: Memory | null }> {
    const { client, runtime, content, roomId, commentOn, dryRun } = opts;

    if (dryRun) {
        runtime.logger.info(
            `[lens] DRY RUN: Would post: ${content.substring(0, 100)}...`
        );
        return { post: null, memory: null };
    }

    const { hash, error } = await client.createPublication(
        content,
        commentOn
    );

    if (!hash) {
        runtime.logger.error(`[lens] Failed to post: ${error}`);
        return { post: null, memory: null };
    }

    runtime.logger.info(`[lens] Posted: ${hash}`);

    // Wait for indexing and get the full post
    const post = await client.waitForIndexing(hash);

    if (!post) {
        runtime.logger.warn(`[lens] Post created (${hash}) but not yet indexed`);
    }

    // Create memory for the post
    const memory: Memory = {
        id: stringToUuid(`lens-${hash}-${runtime.agentId}`),
        entityId: runtime.agentId,
        agentId: runtime.agentId,
        roomId: stringToUuid(roomId),
        content: {
            text: content,
            source: "lens",
            url: post?.id ? `https://hey.xyz/posts/${post.id}` : undefined,
        } as Content,
        createdAt: Date.now(),
    };

    await runtime.createMemory(memory, "messages");

    return { post, memory };
}
