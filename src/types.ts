export type Profile = {
    address: string;
    username: string | null;
    name?: string | null;
    bio?: string | null;
    pfp?: string | null;
};

export type LensPost = {
    id: string;
    content: string;
    author: {
        address: string;
        username?: string;
    };
    commentOn?: { id: string } | null;
    isDeleted: boolean;
    timestamp?: string;
};

export type GraphQLResponse = {
    data?: unknown;
    errors?: Array<{ message: string }>;
};
