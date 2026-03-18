/**
 * Lens Protocol V3 GraphQL client.
 *
 * Replaces the V2 SDK (`@lens-protocol/client`) with direct GraphQL calls
 * to `api.lens.xyz/graphql`. Uses ethers.js for wallet-based authentication.
 */

import crypto from "node:crypto";
import { ethers } from "ethers";
import type { IAgentRuntime } from "@elizaos/core";
import type { GraphQLResponse, LensPost, Profile } from "./types";

const LENS_API_URL = "https://api.lens.xyz/graphql";
const RATE_LIMIT_DELAY_MS = 500;
const MAX_POST_LENGTH = 5000;

export class LensClient {
    private runtime: IAgentRuntime;
    private apiKey: string;
    private appAddress: string;
    private accountAddress: string;
    private wallet: ethers.Wallet;
    private origin: string;
    private accessToken: string | null = null;
    private refreshToken: string | null = null;
    private cache: Map<string, unknown>;
    authenticated = false;
    accountUsername: string | null = null;

    constructor(
        runtime: IAgentRuntime,
        cache: Map<string, unknown>,
        opts: {
            apiKey: string;
            appAddress: string;
            accountAddress: string;
            privateKey: string;
            origin?: string;
        }
    ) {
        this.runtime = runtime;
        this.cache = cache;
        this.apiKey = opts.apiKey;
        this.appAddress = opts.appAddress;
        this.accountAddress = opts.accountAddress;
        this.wallet = new ethers.Wallet(opts.privateKey);
        this.origin = opts.origin ?? "https://lens.xyz";
    }

    // -----------------------------------------------------------------------
    // GraphQL transport
    // -----------------------------------------------------------------------

    private async graphql(
        query: string,
        variables: Record<string, unknown> = {},
        authenticated = false
    ): Promise<GraphQLResponse> {
        await sleep(RATE_LIMIT_DELAY_MS);

        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            Origin: this.origin,
        };
        if (this.apiKey) headers["x-api-key"] = this.apiKey;
        if (authenticated && this.accessToken) {
            headers.Authorization = `Bearer ${this.accessToken}`;
        }

        const res = await fetch(LENS_API_URL, {
            method: "POST",
            headers,
            body: JSON.stringify({ query, variables }),
        });

        if (!res.ok) return { errors: [{ message: `HTTP ${res.status}` }] };
        return (await res.json()) as GraphQLResponse;
    }

    // -----------------------------------------------------------------------
    // Authentication (3-step wallet signing)
    // -----------------------------------------------------------------------

    async authenticate(): Promise<boolean> {
        try {
            const challengeResult = await this.graphql(
                `mutation Challenge($request: ChallengeRequest!) {
                    challenge(request: $request) { id text }
                }`,
                {
                    request: {
                        accountOwner: {
                            account: this.accountAddress,
                            app: this.appAddress,
                            owner: this.wallet.address,
                        },
                    },
                }
            );

            if (challengeResult.errors) {
                this.runtime.logger.error(
                    `[lens] Challenge failed: ${challengeResult.errors[0]?.message}`
                );
                return false;
            }

            const challenge = (
                challengeResult.data as {
                    challenge: { id: string; text: string };
                }
            ).challenge;

            const signature = await this.wallet.signMessage(challenge.text);

            const authResult = await this.graphql(
                `mutation Authenticate($request: SignedAuthChallenge!) {
                    authenticate(request: $request) {
                        ... on AuthenticationTokens { accessToken refreshToken }
                        ... on WrongSignerError { reason }
                        ... on ExpiredChallengeError { reason }
                        ... on ForbiddenError { reason }
                    }
                }`,
                { request: { id: challenge.id, signature } }
            );

            if (authResult.errors) {
                this.runtime.logger.error(
                    `[lens] Auth failed: ${authResult.errors[0]?.message}`
                );
                return false;
            }

            const auth = (
                authResult.data as {
                    authenticate: {
                        accessToken?: string;
                        refreshToken?: string;
                        reason?: string;
                    };
                }
            ).authenticate;

            if (auth.accessToken) {
                this.accessToken = auth.accessToken;
                this.refreshToken = auth.refreshToken ?? null;
                this.authenticated = true;
                this.runtime.logger.info("[lens] Authentication successful");
                return true;
            }

            this.runtime.logger.error(`[lens] Auth rejected: ${auth.reason}`);
            return false;
        } catch (err) {
            this.runtime.logger.error(`[lens] Auth error: ${err}`);
            return false;
        }
    }

    /** Refresh the access token using the stored refresh token. Falls back to full re-auth. */
    async refreshAuth(): Promise<boolean> {
        if (!this.refreshToken) return this.authenticate();

        try {
            const result = await this.graphql(
                `mutation Refresh($request: RefreshRequest!) {
                    refresh(request: $request) {
                        ... on AuthenticationTokens { accessToken refreshToken }
                        ... on ForbiddenError { reason }
                    }
                }`,
                { request: { refreshToken: this.refreshToken } }
            );

            const refresh = (
                result.data as {
                    refresh?: {
                        accessToken?: string;
                        refreshToken?: string;
                        reason?: string;
                    };
                }
            )?.refresh;

            if (refresh?.accessToken) {
                this.accessToken = refresh.accessToken;
                this.refreshToken = refresh.refreshToken ?? this.refreshToken;
                this.runtime.logger.debug("[lens] Token refreshed");
                return true;
            }

            // Refresh failed — fall back to full re-authentication
            this.runtime.logger.warn("[lens] Token refresh failed, re-authenticating");
            return this.authenticate();
        } catch {
            return this.authenticate();
        }
    }

    /** Execute an authenticated GraphQL call, auto-refreshing on auth errors. */
    private async authenticatedGraphql(
        query: string,
        variables: Record<string, unknown> = {}
    ): Promise<GraphQLResponse> {
        const result = await this.graphql(query, variables, true);

        // If we get an auth error, refresh and retry once
        const firstError = (result.errors?.[0]?.message ?? "").toLowerCase();
        if (
            firstError.includes("unauthenticated") ||
            firstError.includes("expired") ||
            firstError.includes("unauthorized") ||
            firstError.includes("authentication")
        ) {
            const refreshed = await this.refreshAuth();
            if (refreshed) {
                return this.graphql(query, variables, true);
            }
        }

        return result;
    }

    // -----------------------------------------------------------------------
    // Publications
    // -----------------------------------------------------------------------

    async createPublication(
        content: string,
        commentOn?: string
    ): Promise<{ hash: string | null; error?: string }> {
        if (content.length > MAX_POST_LENGTH) {
            return {
                hash: null,
                error: `Content exceeds ${MAX_POST_LENGTH} char limit`,
            };
        }

        const metadata = {
            $schema:
                "https://json-schemas.lens.dev/posts/text-only/3.0.0.json",
            lens: {
                id: crypto.randomUUID(),
                mainContentFocus: "TEXT_ONLY",
                locale: "en",
                content,
            },
        };

        const contentUri = `data:application/json,${encodeURIComponent(
            JSON.stringify(metadata)
        )}`;

        const request: Record<string, unknown> = { contentUri };
        if (commentOn) request.commentOn = commentOn;

        const result = await this.authenticatedGraphql(
            `mutation Post($request: CreatePostRequest!) {
                post(request: $request) {
                    ... on PostResponse { hash }
                    ... on SponsoredTransactionRequest { reason }
                    ... on SelfFundedTransactionRequest { reason }
                    ... on TransactionWillFail { reason }
                }
            }`,
            { request }
        );

        if (result.errors) {
            return { hash: null, error: result.errors[0]?.message };
        }

        const data = (
            result.data as { post?: { hash?: string; reason?: string } }
        )?.post;

        if (data?.hash) return { hash: data.hash };
        return { hash: null, error: data?.reason ?? "Unknown error" };
    }

    async getPublication(idOrHash: string): Promise<LensPost | null> {
        const cached = this.cache.get(`post:${idOrHash}`);
        if (cached) return cached as LensPost;

        const isHash = idOrHash.startsWith("0x");
        const request = isHash
            ? { txHash: idOrHash }
            : { post: idOrHash };

        const result = await this.graphql(
            `query Post($request: PostRequest!) {
                post(request: $request) {
                    ... on Post {
                        id
                        isDeleted
                        timestamp
                        author { address username { localName } }
                        metadata { ... on TextOnlyMetadata { content } }
                        commentOn { ... on Post { id } }
                    }
                }
            }`,
            { request }
        );

        const raw = (result.data as { post?: Record<string, unknown> })?.post;
        if (!raw) return null;

        const post = rawToLensPost(raw);
        this.cache.set(`post:${idOrHash}`, post);
        if (post.id !== idOrHash) this.cache.set(`post:${post.id}`, post);
        return post;
    }

    async waitForIndexing(
        txHash: string,
        maxAttempts = 10
    ): Promise<LensPost | null> {
        for (let i = 0; i < maxAttempts; i++) {
            await sleep(2000);
            const statusResult = await this.graphql(
                `query TransactionStatus($request: TransactionStatusRequest!) {
                    transactionStatus(request: $request) {
                        __typename
                        ... on FinishedTransactionStatus { blockTimestamp }
                        ... on FailedTransactionStatus { reason }
                        ... on NotIndexedYetStatus { reason }
                    }
                }`,
                { request: { txHash } }
            );
            const status = (
                statusResult.data as {
                    transactionStatus?: {
                        __typename?: string;
                        blockTimestamp?: string;
                        reason?: string;
                    };
                }
            )?.transactionStatus;

            if (status?.__typename === "FinishedTransactionStatus") break;
            if (status?.__typename === "FailedTransactionStatus") return null;
        }

        return this.getPublication(txHash);
    }

    async getPublicationsFor(
        accountAddress: string,
        limit = 50
    ): Promise<LensPost[]> {
        const result = await this.graphql(
            `query Posts($request: PostsRequest!) {
                posts(request: $request) {
                    items {
                        ... on Post {
                            id isDeleted timestamp
                            author { address username { localName } }
                            metadata { ... on TextOnlyMetadata { content } }
                            commentOn { ... on Post { id } }
                        }
                    }
                }
            }`,
            {
                request: {
                    filter: { authors: [accountAddress] },
                    pageSize: limit > 10 ? "FIFTY" : "TEN",
                },
            }
        );

        const items = (
            result.data as {
                posts?: { items?: Array<Record<string, unknown>> };
            }
        )?.posts?.items ?? [];

        return items.map(rawToLensPost);
    }

    // -----------------------------------------------------------------------
    // Notifications / Mentions
    // -----------------------------------------------------------------------

    async getMentions(): Promise<
        Array<{
            id: string;
            post: LensPost;
        }>
    > {
        const result = await this.authenticatedGraphql(
            `query Notifications($request: NotificationRequest!) {
                notifications(request: $request) {
                    items {
                        ... on MentionNotification {
                            id
                            post {
                                ... on Post {
                                    id isDeleted timestamp
                                    author { address username { localName } }
                                    metadata { ... on TextOnlyMetadata { content } }
                                    commentOn { ... on Post { id } }
                                }
                            }
                        }
                        ... on CommentNotification {
                            id
                            comment {
                                ... on Post {
                                    id isDeleted timestamp
                                    author { address username { localName } }
                                    metadata { ... on TextOnlyMetadata { content } }
                                    commentOn { ... on Post { id } }
                                }
                            }
                        }
                    }
                }
            }`,
            { request: { orderBy: "DEFAULT" } }
        );

        const items = (
            result.data as {
                notifications?: {
                    items?: Array<{
                        id: string;
                        post?: Record<string, unknown>;
                        comment?: Record<string, unknown>;
                    }>;
                };
            }
        )?.notifications?.items ?? [];

        return items
            .map((item) => {
                const raw = item.post ?? item.comment;
                if (!raw) return null;
                return { id: item.id, post: rawToLensPost(raw) };
            })
            .filter(Boolean) as Array<{ id: string; post: LensPost }>;
    }

    // -----------------------------------------------------------------------
    // Profiles
    // -----------------------------------------------------------------------

    async getProfile(address?: string): Promise<Profile | null> {
        const addr = address ?? this.accountAddress;
        const cached = this.cache.get(`profile:${addr}`);
        if (cached) return cached as Profile;

        const result = await this.graphql(
            `query Account($request: AccountRequest!) {
                account(request: $request) {
                    address
                    username { localName }
                    metadata { name bio picture }
                }
            }`,
            { request: { address: addr } }
        );

        const raw = (
            result.data as {
                account?: {
                    address: string;
                    username?: { localName: string };
                    metadata?: {
                        name?: string;
                        bio?: string;
                        picture?: string;
                    };
                };
            }
        )?.account;

        if (!raw) return null;

        const profile: Profile = {
            address: raw.address,
            username: raw.username?.localName ?? null,
            name: raw.metadata?.name ?? null,
            bio: raw.metadata?.bio ?? null,
            pfp: raw.metadata?.picture ?? null,
        };

        this.cache.set(`profile:${addr}`, profile);
        return profile;
    }

    // -----------------------------------------------------------------------
    // Timeline
    // -----------------------------------------------------------------------

    async getTimeline(address?: string, limit = 10): Promise<LensPost[]> {
        const addr = address ?? this.accountAddress;
        const result = await this.authenticatedGraphql(
            `query Timeline($request: TimelineRequest!) {
                timeline(request: $request) {
                    items {
                        ... on Post {
                            id isDeleted timestamp
                            author { address username { localName } }
                            metadata { ... on TextOnlyMetadata { content } }
                            commentOn { ... on Post { id } }
                        }
                    }
                }
            }`,
            {
                request: {
                    account: addr,
                    pageSize: limit > 10 ? "FIFTY" : "TEN",
                },
            }
        );

        const items = (
            result.data as {
                timeline?: { items?: Array<Record<string, unknown>> };
            }
        )?.timeline?.items ?? [];

        return items.filter((raw) => raw.id).map(rawToLensPost);
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rawToLensPost(raw: Record<string, unknown>): LensPost {
    const author = (raw.author ?? {}) as {
        address?: string;
        username?: { localName?: string };
    };
    const commentOn = raw.commentOn as { id?: string } | null | undefined;

    return {
        id: (raw.id as string) ?? "",
        content:
            (raw.metadata as { content?: string } | undefined)?.content ?? "",
        author: {
            address: author.address ?? "",
            username: author.username?.localName,
        },
        commentOn: commentOn?.id ? { id: commentOn.id } : null,
        isDeleted: (raw.isDeleted as boolean) ?? false,
        timestamp: (raw.timestamp as string) ?? undefined,
    };
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
