// src/client.ts
import crypto from "crypto";
import { ethers } from "ethers";
var LENS_API_URL = "https://api.lens.xyz/graphql";
var RATE_LIMIT_DELAY_MS = 500;
var MAX_POST_LENGTH = 5e3;
var LensClient = class {
  runtime;
  apiKey;
  appAddress;
  accountAddress;
  wallet;
  origin;
  accessToken = null;
  refreshToken = null;
  cache;
  authenticated = false;
  accountUsername = null;
  constructor(runtime, cache, opts) {
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
  async graphql(query, variables = {}, authenticated = false) {
    await sleep(RATE_LIMIT_DELAY_MS);
    const headers = {
      "Content-Type": "application/json",
      Origin: this.origin
    };
    if (this.apiKey) headers["x-api-key"] = this.apiKey;
    if (authenticated && this.accessToken) {
      headers.Authorization = `Bearer ${this.accessToken}`;
    }
    const res = await fetch(LENS_API_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ query, variables })
    });
    if (!res.ok) return { errors: [{ message: `HTTP ${res.status}` }] };
    return await res.json();
  }
  // -----------------------------------------------------------------------
  // Authentication (3-step wallet signing)
  // -----------------------------------------------------------------------
  async authenticate() {
    var _a, _b;
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
              owner: this.wallet.address
            }
          }
        }
      );
      if (challengeResult.errors) {
        this.runtime.logger.error(
          `[lens] Challenge failed: ${(_a = challengeResult.errors[0]) == null ? void 0 : _a.message}`
        );
        return false;
      }
      const challenge = challengeResult.data.challenge;
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
          `[lens] Auth failed: ${(_b = authResult.errors[0]) == null ? void 0 : _b.message}`
        );
        return false;
      }
      const auth = authResult.data.authenticate;
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
  async refreshAuth() {
    var _a;
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
      const refresh = (_a = result.data) == null ? void 0 : _a.refresh;
      if (refresh == null ? void 0 : refresh.accessToken) {
        this.accessToken = refresh.accessToken;
        this.refreshToken = refresh.refreshToken ?? this.refreshToken;
        this.runtime.logger.debug("[lens] Token refreshed");
        return true;
      }
      this.runtime.logger.warn("[lens] Token refresh failed, re-authenticating");
      return this.authenticate();
    } catch {
      return this.authenticate();
    }
  }
  /** Execute an authenticated GraphQL call, auto-refreshing on auth errors. */
  async authenticatedGraphql(query, variables = {}) {
    var _a, _b;
    const result = await this.graphql(query, variables, true);
    const firstError = ((_b = (_a = result.errors) == null ? void 0 : _a[0]) == null ? void 0 : _b.message) ?? "";
    if (firstError.includes("Unauthenticated") || firstError.includes("expired")) {
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
  async createPublication(content, commentOn) {
    var _a, _b;
    if (content.length > MAX_POST_LENGTH) {
      return {
        hash: null,
        error: `Content exceeds ${MAX_POST_LENGTH} char limit`
      };
    }
    const metadata = {
      $schema: "https://json-schemas.lens.dev/posts/text-only/3.0.0.json",
      lens: {
        id: crypto.randomUUID(),
        mainContentFocus: "TEXT_ONLY",
        locale: "en",
        content
      }
    };
    const contentUri = `data:application/json,${encodeURIComponent(
      JSON.stringify(metadata)
    )}`;
    const request = { contentUri };
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
      return { hash: null, error: (_a = result.errors[0]) == null ? void 0 : _a.message };
    }
    const data = (_b = result.data) == null ? void 0 : _b.post;
    if (data == null ? void 0 : data.hash) return { hash: data.hash };
    return { hash: null, error: (data == null ? void 0 : data.reason) ?? "Unknown error" };
  }
  async getPublication(idOrHash) {
    var _a;
    const cached = this.cache.get(`post:${idOrHash}`);
    if (cached) return cached;
    const isHash = idOrHash.startsWith("0x");
    const request = isHash ? { txHash: idOrHash } : { post: idOrHash };
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
    const raw = (_a = result.data) == null ? void 0 : _a.post;
    if (!raw) return null;
    const post = rawToLensPost(raw);
    this.cache.set(`post:${idOrHash}`, post);
    if (post.id !== idOrHash) this.cache.set(`post:${post.id}`, post);
    return post;
  }
  async waitForIndexing(txHash, maxAttempts = 10) {
    var _a;
    for (let i = 0; i < maxAttempts; i++) {
      await sleep(2e3);
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
      const status = (_a = statusResult.data) == null ? void 0 : _a.transactionStatus;
      if ((status == null ? void 0 : status.__typename) === "FinishedTransactionStatus") break;
      if ((status == null ? void 0 : status.__typename) === "FailedTransactionStatus") return null;
    }
    return this.getPublication(txHash);
  }
  async getPublicationsFor(accountAddress, limit = 50) {
    var _a, _b;
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
          pageSize: limit > 10 ? "FIFTY" : "TEN"
        }
      }
    );
    const items = ((_b = (_a = result.data) == null ? void 0 : _a.posts) == null ? void 0 : _b.items) ?? [];
    return items.map(rawToLensPost);
  }
  // -----------------------------------------------------------------------
  // Notifications / Mentions
  // -----------------------------------------------------------------------
  async getMentions() {
    var _a, _b;
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
    const items = ((_b = (_a = result.data) == null ? void 0 : _a.notifications) == null ? void 0 : _b.items) ?? [];
    return items.map((item) => {
      const raw = item.post ?? item.comment;
      if (!raw) return null;
      return { id: item.id, post: rawToLensPost(raw) };
    }).filter(Boolean);
  }
  // -----------------------------------------------------------------------
  // Profiles
  // -----------------------------------------------------------------------
  async getProfile(address) {
    var _a, _b, _c, _d, _e;
    const addr = address ?? this.accountAddress;
    const cached = this.cache.get(`profile:${addr}`);
    if (cached) return cached;
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
    const raw = (_a = result.data) == null ? void 0 : _a.account;
    if (!raw) return null;
    const profile = {
      address: raw.address,
      username: ((_b = raw.username) == null ? void 0 : _b.localName) ?? null,
      name: ((_c = raw.metadata) == null ? void 0 : _c.name) ?? null,
      bio: ((_d = raw.metadata) == null ? void 0 : _d.bio) ?? null,
      pfp: ((_e = raw.metadata) == null ? void 0 : _e.picture) ?? null
    };
    this.cache.set(`profile:${addr}`, profile);
    return profile;
  }
  // -----------------------------------------------------------------------
  // Timeline
  // -----------------------------------------------------------------------
  async getTimeline(address, limit = 10) {
    var _a, _b;
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
          pageSize: limit > 10 ? "FIFTY" : "TEN"
        }
      }
    );
    const items = ((_b = (_a = result.data) == null ? void 0 : _a.timeline) == null ? void 0 : _b.items) ?? [];
    return items.filter((raw) => raw.id).map(rawToLensPost);
  }
};
function rawToLensPost(raw) {
  var _a, _b, _c, _d;
  return {
    id: raw.id,
    content: ((_a = raw.metadata) == null ? void 0 : _a.content) ?? "",
    author: {
      address: ((_b = raw.author) == null ? void 0 : _b.address) ?? "",
      username: (_d = (_c = raw.author) == null ? void 0 : _c.username) == null ? void 0 : _d.localName
    },
    commentOn: raw.commentOn ? { id: raw.commentOn.id } : null,
    isDeleted: raw.isDeleted ?? false,
    timestamp: raw.timestamp
  };
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// src/post.ts
import {
  composePrompt,
  ModelType,
  stringToUuid as stringToUuid2
} from "@elizaos/core";

// src/prompts.ts
var messageCompletionFooter = `
Response format should be formatted in a JSON block like this:
\`\`\`json
{ "user": "{{agentName}}", "text": "string", "action": "string" }
\`\`\``;
var shouldRespondFooter = `
Choose one of [RESPOND, IGNORE, STOP] and write your choice only.`;
var formatPublication = (post) => {
  return `ID: ${post.id}
    From: ${post.author.username ?? post.author.address}${post.commentOn ? `
In reply to: ${post.commentOn.id}` : ""}
Text: ${post.content}`;
};
var formatTimeline = (character, timeline) => `# ${character.name}'s Home Timeline
${timeline.map(formatPublication).join("\n")}
`;
var headerTemplate = `
{{timeline}}

# Knowledge
{{knowledge}}

About {{agentName}} (@{{lensHandle}}):
{{bio}}
{{lore}}
{{postDirections}}

{{providers}}

{{recentPosts}}

{{characterPostExamples}}`;
var postTemplate = headerTemplate + `
# Task: Generate a post in the voice and style of {{agentName}}, aka @{{lensHandle}}
Write a single sentence post that is {{adjective}} about {{topic}} (without mentioning {{topic}} directly), from the perspective of {{agentName}}.
Try to write something totally different than previous posts. Do not add commentary or acknowledge this request, just write the post.

Your response should not contain any questions. Brief, concise statements only. No emojis. Use \\n\\n (double spaces) between statements.`;
var messageHandlerTemplate = headerTemplate + `
Recent interactions between {{agentName}} and other users:
{{recentPostInteractions}}

Thread of publications You Are Replying To:
{{formattedConversation}}

# Task: Generate a post in the voice, style and perspective of {{agentName}} (@{{lensHandle}}):
{{currentPost}}` + messageCompletionFooter;
var shouldRespondTemplate = `# Task: Decide if {{agentName}} should respond.
    About {{agentName}}:
    {{bio}}

    # INSTRUCTIONS: Determine if {{agentName}} (@{{lensHandle}}) should respond to the message and participate in the conversation. Do not comment. Just respond with "RESPOND" or "IGNORE" or "STOP".

Response options are RESPOND, IGNORE and STOP.

{{agentName}} should respond to messages that are directed at them, or participate in conversations that are interesting or relevant to their background, IGNORE messages that are irrelevant to them, and should STOP if the conversation is concluded.

{{agentName}} is in a room with other users and wants to be conversational, but not annoying.
{{agentName}} should RESPOND to messages that are directed at them, or participate in conversations that are interesting or relevant to their background.
If a message is not interesting or relevant, {{agentName}} should IGNORE.
If a message thread has become repetitive, {{agentName}} should IGNORE.
Unless directly RESPONDing to a user, {{agentName}} should IGNORE messages that are very short or do not contain much information.
If a user asks {{agentName}} to stop talking, {{agentName}} should STOP.
If {{agentName}} concludes a conversation and isn't part of the conversation anymore, {{agentName}} should STOP.

IMPORTANT: {{agentName}} (aka @{{lensHandle}}) is particularly sensitive about being annoying, so if there is any doubt, it is better to IGNORE than to RESPOND.

Thread of messages You Are Replying To:
{{formattedConversation}}

Current message:
{{currentPost}}

` + shouldRespondFooter;

// src/actions.ts
import { stringToUuid } from "@elizaos/core";
async function sendPublication(opts) {
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
  const post = await client.waitForIndexing(hash);
  if (!post) {
    runtime.logger.warn(`[lens] Post created (${hash}) but not yet indexed`);
  }
  const memory = {
    id: stringToUuid(`lens-${hash}-${runtime.agentId}`),
    entityId: runtime.agentId,
    agentId: runtime.agentId,
    roomId: stringToUuid(roomId),
    content: {
      text: content,
      source: "lens",
      url: (post == null ? void 0 : post.id) ? `https://hey.xyz/posts/${post.id}` : void 0
    },
    createdAt: Date.now()
  };
  await runtime.createMemory(memory, "messages");
  return { post, memory };
}

// src/post.ts
var LensPostManager = class {
  client;
  runtime;
  accountAddress;
  dryRun;
  postTimer = null;
  constructor(client, runtime, accountAddress) {
    this.client = client;
    this.runtime = runtime;
    this.accountAddress = accountAddress;
    this.dryRun = runtime.getSetting("LENS_DRY_RUN") === "true";
  }
  async start() {
    await this.generateNewPublication();
    this.scheduleNext();
  }
  async stop() {
    if (this.postTimer) {
      clearTimeout(this.postTimer);
      this.postTimer = null;
    }
  }
  scheduleNext() {
    const minMs = 60 * 60 * 1e3;
    const maxMs = 4 * 60 * 60 * 1e3;
    const delay = Math.floor(Math.random() * (maxMs - minMs)) + minMs;
    this.runtime.logger.info(
      `[lens] Next post in ${Math.round(delay / 6e4)} minutes`
    );
    this.postTimer = setTimeout(async () => {
      await this.generateNewPublication();
      this.scheduleNext();
    }, delay);
  }
  async generateNewPublication() {
    try {
      const runtime = this.runtime;
      const profile = await this.client.getProfile();
      const timeline = await this.client.getTimeline();
      const formattedTimeline = formatTimeline(
        runtime.character,
        timeline
      );
      const recentPosts = await this.client.getPublicationsFor(
        this.accountAddress,
        10
      );
      const recentPostsText = recentPosts.map((p) => p.content).join("\n");
      const roomId = stringToUuid2(`lens-post-${this.accountAddress}`);
      const topics = runtime.character.topics ?? [];
      const topic = topics[Math.floor(Math.random() * topics.length)] ?? "something interesting";
      const adjectives = runtime.character.adjectives ?? [];
      const adjective = adjectives[Math.floor(Math.random() * adjectives.length)] ?? "thought-provoking";
      const state = await runtime.composeState(
        {
          entityId: runtime.agentId,
          agentId: runtime.agentId,
          roomId,
          content: { text: "", source: "lens" }
        },
        {
          lensHandle: (profile == null ? void 0 : profile.username) ?? this.accountAddress,
          timeline: formattedTimeline,
          recentPosts: recentPostsText,
          topic,
          adjective
        }
      );
      const context = composePrompt({
        state,
        template: postTemplate
      });
      const result = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: context
      });
      const text = typeof result === "string" ? result : (result == null ? void 0 : result.text) ?? "";
      if (!(text == null ? void 0 : text.trim())) {
        runtime.logger.debug("[lens] No post text generated");
        return;
      }
      const cleanText = text.replace(/^["']|["']$/g, "").trim();
      await sendPublication({
        client: this.client,
        runtime,
        content: cleanText,
        roomId,
        dryRun: this.dryRun
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
};

// src/interactions.ts
import {
  composePrompt as composePrompt2,
  stringToUuid as stringToUuid5,
  ModelType as ModelType2
} from "@elizaos/core";

// src/memory.ts
import {
  stringToUuid as stringToUuid4
} from "@elizaos/core";

// src/utils.ts
import { stringToUuid as stringToUuid3 } from "@elizaos/core";
function publicationUuid(opts) {
  return stringToUuid3(`lens-${opts.pubId}-${opts.agentId}`);
}

// src/memory.ts
function createPublicationMemory(opts) {
  const { post, agentId, roomId } = opts;
  return {
    id: stringToUuid4(
      publicationUuid({ pubId: post.id, agentId })
    ),
    agentId: stringToUuid4(agentId),
    entityId: stringToUuid4(post.author.address),
    roomId: stringToUuid4(roomId),
    content: {
      text: post.content,
      source: "lens",
      url: `https://hey.xyz/posts/${post.id}`,
      inReplyTo: post.commentOn ? stringToUuid4(
        publicationUuid({
          pubId: post.commentOn.id,
          agentId
        })
      ) : void 0
    },
    createdAt: post.timestamp ? new Date(post.timestamp).getTime() : Date.now(),
    embedding: new Array(1536).fill(0)
  };
}
async function buildConversationThread(opts) {
  const { post, client, runtime, agentId, roomId } = opts;
  const thread = [post];
  let current = post;
  while (current.commentOn) {
    const parent = await client.getPublication(current.commentOn.id);
    if (!parent) break;
    thread.unshift(parent);
    const memoryId = stringToUuid4(
      publicationUuid({ pubId: parent.id, agentId })
    );
    const exists = await runtime.getMemoryById(memoryId);
    if (!exists) {
      const memory = createPublicationMemory({
        post: parent,
        agentId,
        roomId
      });
      await runtime.createMemory(memory, "messages");
    }
    current = parent;
  }
  return thread;
}

// src/interactions.ts
var LensInteractionManager = class {
  client;
  runtime;
  accountAddress;
  pollInterval;
  dryRun;
  seenNotificationIds = /* @__PURE__ */ new Set();
  pollTimer = null;
  constructor(client, runtime, accountAddress) {
    this.client = client;
    this.runtime = runtime;
    this.accountAddress = accountAddress;
    const interval = runtime.getSetting("LENS_POLL_INTERVAL");
    const parsed = typeof interval === "string" ? parseInt(interval, 10) : NaN;
    this.pollInterval = (Number.isFinite(parsed) && parsed > 0 ? parsed : 120) * 1e3;
    this.dryRun = runtime.getSetting("LENS_DRY_RUN") === "true";
  }
  async start() {
    await this.handleInteractions();
    this.pollTimer = setInterval(
      () => this.handleInteractions(),
      this.pollInterval
    );
  }
  async stop() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
  async handleInteractions() {
    try {
      const mentions = await this.client.getMentions();
      for (const mention of mentions) {
        if (this.seenNotificationIds.has(mention.id)) continue;
        this.seenNotificationIds.add(mention.id);
        const post = mention.post;
        if (post.author.address.toLowerCase() === this.accountAddress.toLowerCase()) {
          continue;
        }
        const memoryId = stringToUuid5(
          publicationUuid({
            pubId: post.id,
            agentId: this.runtime.agentId
          })
        );
        const exists = await this.runtime.getMemoryById(memoryId);
        if (exists) continue;
        await this.handleMention(post);
      }
      if (this.seenNotificationIds.size > 1e3) {
        const ids = Array.from(this.seenNotificationIds);
        this.seenNotificationIds = new Set(ids.slice(-500));
      }
    } catch (err) {
      this.runtime.logger.error(
        `[lens] Error handling interactions: ${err}`
      );
    }
  }
  async handleMention(post) {
    const runtime = this.runtime;
    const roomId = stringToUuid5(`lens-room-${post.id}`);
    const fullPost = await this.client.getPublication(post.id);
    if (!fullPost) return;
    const thread = await buildConversationThread({
      post: fullPost,
      client: this.client,
      runtime,
      agentId: runtime.agentId,
      roomId
    });
    const formattedConversation = thread.map(formatPublication).join("\n\n");
    const timeline = await this.client.getTimeline();
    const formattedTimeline = formatTimeline(
      runtime.character,
      timeline
    );
    const memory = createPublicationMemory({
      post: fullPost,
      agentId: runtime.agentId,
      roomId
    });
    await runtime.createMemory(memory, "messages");
    const state = await runtime.composeState(memory, {
      lensHandle: this.client.accountUsername ?? this.accountAddress,
      timeline: formattedTimeline,
      formattedConversation,
      currentPost: `From: @${post.author.username ?? post.author.address}
${post.content}`
    });
    const shouldRespondContext = composePrompt2({
      state,
      template: shouldRespondTemplate
    });
    const shouldRespondResult = await runtime.useModel(ModelType2.TEXT_SMALL, {
      prompt: shouldRespondContext
    });
    const shouldRespondText = typeof shouldRespondResult === "string" ? shouldRespondResult : (shouldRespondResult == null ? void 0 : shouldRespondResult.text) ?? "";
    const shouldRespond = shouldRespondText.includes("RESPOND") ? "RESPOND" : shouldRespondText.includes("STOP") ? "STOP" : "IGNORE";
    if (shouldRespond !== "RESPOND") {
      runtime.logger.debug(
        `[lens] Decided not to respond to ${post.id}: ${shouldRespond}`
      );
      return;
    }
    const responseContext = composePrompt2({
      state,
      template: messageHandlerTemplate
    });
    const responseResult = await runtime.useModel(ModelType2.TEXT_LARGE, {
      prompt: responseContext
    });
    const response = typeof responseResult === "string" ? { text: responseResult } : responseResult ?? { text: "" };
    if (!(response == null ? void 0 : response.text)) {
      runtime.logger.debug(`[lens] No response generated for ${post.id}`);
      return;
    }
    await sendPublication({
      client: this.client,
      runtime,
      content: response.text,
      roomId,
      commentOn: post.id,
      dryRun: this.dryRun
    });
    runtime.logger.info(
      `[lens] Replied to ${post.id}: ${response.text.substring(0, 80)}...`
    );
  }
};

// src/lens-client.ts
var LensAgentClient = class _LensAgentClient {
  client;
  posts;
  interactions;
  runtime;
  constructor(runtime) {
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
    const cache = /* @__PURE__ */ new Map();
    const origin = runtime.getSetting("LENS_ORIGIN");
    this.client = new LensClient(runtime, cache, {
      apiKey,
      appAddress,
      accountAddress,
      privateKey,
      origin: typeof origin === "string" ? origin : void 0
    });
    this.posts = new LensPostManager(
      this.client,
      runtime,
      accountAddress
    );
    this.interactions = new LensInteractionManager(
      this.client,
      runtime,
      accountAddress
    );
  }
  async start() {
    const runtime = this.runtime;
    const ok = await this.client.authenticate();
    if (!ok) {
      throw new Error(
        "[lens] Authentication failed \u2014 check LENS_API_KEY, LENS_ACCOUNT_ADDRESS, LENS_PRIVATE_KEY, and LENS_APP_ADDRESS"
      );
    }
    const profile = await this.client.getProfile();
    if (profile) {
      this.client.accountUsername = profile.username;
      runtime.logger.info(
        `[lens] Logged in as ${profile.username ?? profile.address}`
      );
    }
    await this.posts.start();
    await this.interactions.start();
    runtime.logger.info("[lens] Client started");
  }
  async stop() {
    await this.posts.stop();
    await this.interactions.stop();
    this.runtime.logger.info("[lens] Client stopped");
  }
  static async start(runtime) {
    const client = new _LensAgentClient(runtime);
    await client.start();
    return client;
  }
};
export {
  LensAgentClient
};
//# sourceMappingURL=lens-client-C2MTSBTA.js.map