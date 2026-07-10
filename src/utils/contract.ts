import { createPublicClient, Hex, http } from "viem";
import { sepolia } from "viem/chains";
import { PORTAL_CONTRACT_ABI } from "../abi/portal-contract-abi";
import { IDENTITY_MODULE_ABI } from "../abi/identity-module-abi";
import MemberCreds from "node-cache";
import { config } from "../config";
const cache = new MemberCreds({
  stdTTL: 60 * 60 * 24, // 24 hours
});

export const publicClient = createPublicClient({
  chain: sepolia,
  transport: http(config.rpcURL),
});

export const getLegacyPortalCollaboratorKeys = async (
  contractAddress: Hex,
  collaboratorAddress: Hex
) => {
  try {
    const [_, did] = (await publicClient.readContract({
      address: contractAddress,
      abi: PORTAL_CONTRACT_ABI,
      functionName: "collaboratorKeys",
      args: [collaboratorAddress],
    })) as [string, string];

    return did;
  } catch (error) {
    console.error("Could not get legacy portal keys");
    return null;
  }
};

export const getV2PortalOwnerDid = async (contractAddress: Hex, collaboratorAddress: Hex) => {
  try {
    const result = (await publicClient.readContract({
      address: contractAddress,
      abi: [
        {
          inputs: [
            {
              internalType: "address",
              name: "",
              type: "address",
            },
          ],
          name: "collaboratorKeys",
          outputs: [
            {
              internalType: "string",
              name: "",
              type: "string",
            },
          ],
          stateMutability: "view",
          type: "function",
        },
      ],
      functionName: "collaboratorKeys",
      args: [collaboratorAddress],
    })) as string;

    return result;
  } catch (error) {
    console.error("Error getting v2 portal owner did:", error);
    return null;
  }
};

export const getCollaboratorDid = async (contractAddress: Hex, collaboratorAddress: Hex) => {
  let did = null;
  did = await getLegacyPortalCollaboratorKeys(contractAddress, collaboratorAddress);

  if (did) return did;

  return await getV2PortalOwnerDid(contractAddress, collaboratorAddress);
};

export const getOwnerDid = async (contractAddress: Hex, collaboratorAddress: Hex) => {
  const cacheKey = `${contractAddress}-${collaboratorAddress}`;
  const cachedResult = cache.get(cacheKey);
  if (cachedResult) {
    return cachedResult as string;
  }

  const did = await getCollaboratorDid(contractAddress, collaboratorAddress);
  cache.set(cacheKey, did);

  return did;
};

export const getIdentitySigningDid = async (identityContractAddress: Hex): Promise<string | null> => {
  const cacheKey = `identity-did-${identityContractAddress}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached as string;

  try {
    const details = (await publicClient.readContract({
      address: identityContractAddress,
      abi: IDENTITY_MODULE_ABI,
      functionName: "getIdentityModulePublicDetails",
    })) as { salt: bigint; signingDid: string; accountPublicKey: Hex; agentAddress: Hex };

    if (details?.signingDid) cache.set(cacheKey, details.signingDid);
    return details?.signingDid ?? null;
  } catch (error) {
    console.error("Error reading identity signingDid:", error);
    return null;
  }
};

// App-key (FileverseApp) reads for publish detection. The shared PORTAL_CONTRACT_ABI
// is the legacy shape (files → [metadataIPFSHash, …], no appFileId / appFileIdToFileId),
// so the reconciler carries its own minimal app-key fragment.
const PUBLISHED_CHECK_ABI = [
  {
    inputs: [{ internalType: "string", name: "", type: "string" }],
    name: "appFileIdToFileId",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    name: "files",
    outputs: [
      { internalType: "string", name: "appFileId", type: "string" },
      { internalType: "enum FileverseApp.FileType", name: "fileType", type: "uint8" },
      { internalType: "string", name: "metadataIPFSHash", type: "string" },
      { internalType: "string", name: "contentIPFSHash", type: "string" },
      { internalType: "string", name: "gateIPFSHash", type: "string" },
      { internalType: "uint256", name: "version", type: "uint256" },
      { internalType: "address", name: "owner", type: "address" },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

// A doc is published iff files(appFileIdToFileId(ddocId)).appFileId === ddocId.
// fileIds are 0-indexed on-chain, so appFileIdToFileId==0 is ambiguous (the first
// file, or unset) — the files() read disambiguates. Two batched round-trips.
export const resolvePublishedDocumentIds = async (
  refs: Array<{ documentId: string; portalAddress: string }>
): Promise<Set<string>> => {
  const published = new Set<string>();
  if (refs.length === 0) return published;

  const phase1 = await publicClient.multicall({
    allowFailure: true,
    contracts: refs.map((r) => ({
      address: r.portalAddress as Hex,
      abi: PUBLISHED_CHECK_ABI,
      functionName: "appFileIdToFileId",
      args: [r.documentId],
    })),
  });

  const resolved = refs
    .map((ref, i) => ({ ref, res: phase1[i] }))
    .filter((x) => x.res.status === "success")
    .map((x) => ({ ref: x.ref, fileId: x.res.result as unknown as bigint }));

  if (resolved.length === 0) return published;

  const phase2 = await publicClient.multicall({
    allowFailure: true,
    contracts: resolved.map((x) => ({
      address: x.ref.portalAddress as Hex,
      abi: PUBLISHED_CHECK_ABI,
      functionName: "files",
      args: [x.fileId],
    })),
  });

  resolved.forEach((x, i) => {
    const res = phase2[i];
    if (res.status === "success" && (res.result as readonly unknown[])[0] === x.ref.documentId) {
      published.add(x.ref.documentId);
    }
  });

  return published;
};
