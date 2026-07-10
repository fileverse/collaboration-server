// getIdentityModulePublicDetails — copied from ddocs.new/data/identity-module-abi.ts:376-410.
// Returns a struct { salt, signingDid, accountPublicKey, agentAddress }; we read signingDid.
export const IDENTITY_MODULE_ABI = [
  {
    inputs: [],
    name: "getIdentityModulePublicDetails",
    outputs: [
      {
        components: [
          { internalType: "uint256", name: "salt", type: "uint256" },
          { internalType: "string", name: "signingDid", type: "string" },
          { internalType: "bytes", name: "accountPublicKey", type: "bytes" },
          { internalType: "address", name: "agentAddress", type: "address" },
        ],
        internalType: "struct IIdentityModule.IdentityPublicDetails",
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;
