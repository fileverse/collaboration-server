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

export const getOwnerDid = async (contractAddress: Hex, collaboratorAddress: Hex) => {
  const cacheKey = `${contractAddress}-${collaboratorAddress}`;
  const cachedResult = cache.get(cacheKey);
  if (cachedResult) {
    return cachedResult as string;
  }

  const result = (await publicClient.readContract({
    address: contractAddress,
    abi: PORTAL_CONTRACT_ABI,
    functionName: "collaboratorKeys",
    args: [collaboratorAddress],
  })) as [string, string];

  const [_, did] = result;
  cache.set(cacheKey, did);

  return did;
};
