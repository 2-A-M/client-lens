// src/index.ts
var lensPlugin = {
  name: "lens",
  description: "Lens Protocol V3 connector for posting and receiving on Lens",
  clients: [
    {
      async start(runtime) {
        const { LensAgentClient } = await import("./lens-client-LRMD2UEK.js");
        return LensAgentClient.start(
          runtime
        );
      }
    }
  ],
  actions: []
};
var index_default = lensPlugin;
export {
  index_default as default
};
//# sourceMappingURL=index.js.map