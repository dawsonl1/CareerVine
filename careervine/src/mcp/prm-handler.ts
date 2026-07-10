import {
  protectedResourceHandler,
  metadataCorsOptionsRequestHandler,
} from "mcp-handler";
import { getMcpResourceUrl, getSupabaseAuthIssuer } from "@/mcp/auth-config";

export const mcpProtectedResourceHandler = protectedResourceHandler({
  authServerUrls: [getSupabaseAuthIssuer()],
  resourceUrl: getMcpResourceUrl(),
});

export const mcpProtectedResourceOptions = metadataCorsOptionsRequestHandler();
