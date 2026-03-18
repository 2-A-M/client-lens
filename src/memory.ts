/**
 * Memory persistence helpers for Lens V3 posts.
 */

import {
    type Content,
    type IAgentRuntime,
    type Memory,
    stringToUuid,
} from "@elizaos/core";
import type { LensClient } from "./client";
import type { LensPost } from "./types";
import { publicationUuid } from "./utils";

export function createPublicationMemory(opts: {
    post: LensPost;
    agentId: string;
    roomId: string;
}): Memory {
    const { post, agentId, roomId } = opts;

    return {
        id: stringToUuid(
            publicationUuid({ pubId: post.id, agentId })
        ),
        agentId: stringToUuid(agentId),
        entityId: stringToUuid(post.author.address),
        roomId: stringToUuid(roomId),
        content: {
            text: post.content,
            source: "lens",
            url: `https://hey.xyz/posts/${post.id}`,
            inReplyTo: post.commentOn
                ? stringToUuid(
                      publicationUuid({
                          pubId: post.commentOn.id,
                          agentId,
                      })
                  )
                : undefined,
        } as Content,
        createdAt: post.timestamp
            ? new Date(post.timestamp).getTime()
            : Date.now(),
        embedding: new Array(1536).fill(0),
    };
}

export async function buildConversationThread(opts: {
    post: LensPost;
    client: LensClient;
    runtime: IAgentRuntime;
    agentId: string;
    roomId: string;
}): Promise<LensPost[]> {
    const { post, client, runtime, agentId, roomId } = opts;
    const thread: LensPost[] = [post];

    let current = post;
    while (current.commentOn) {
        const parent = await client.getPublication(current.commentOn.id);
        if (!parent) break;

        thread.unshift(parent);

        // Save memory for unseen posts in the thread
        const memoryId = stringToUuid(
            publicationUuid({ pubId: parent.id, agentId })
        );
        const exists = await runtime.getMemoryById(memoryId);
        if (!exists) {
            const memory = createPublicationMemory({
                post: parent,
                agentId,
                roomId,
            });
            await runtime.createMemory(memory, "messages");
        }

        current = parent;
    }

    return thread;
}
