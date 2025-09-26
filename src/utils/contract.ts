import { createPublicClient, Hex, http } from "viem";
import { sepolia } from "viem/chains";
import { PORTAL_CONTRACT_ABI } from "../abi/portal-contract-abi";
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
