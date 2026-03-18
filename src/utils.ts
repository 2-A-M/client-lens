import { stringToUuid } from "@elizaos/core";

export function publicationUuid(opts: {
    pubId: string;
    agentId: string;
}): string {
    return stringToUuid(`lens-${opts.pubId}-${opts.agentId}`);
}
