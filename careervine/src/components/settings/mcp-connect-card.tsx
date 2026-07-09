"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Bot, Copy, Check } from "lucide-react";

const MCP_URL =
  `${process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "https://www.careervine.app"}/api/mcp`;

export default function McpConnectCard() {
  const [copied, setCopied] = useState(false);

  const copyUrl = async () => {
    await navigator.clipboard.writeText(MCP_URL);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Card variant="outlined">
      <CardContent className="p-7">
        <div className="flex items-center gap-3 mb-4">
          <Bot className="h-6 w-6 text-muted-foreground" />
          <h2 className="text-lg font-medium text-foreground">Connect Claude</h2>
        </div>
        <p className="text-base text-muted-foreground mb-5">
          Give Claude access to your contacts, outreach queue, email drafts, and calendar — scoped to
          your account only.
        </p>

        <div className="rounded-xl border border-outline bg-surface-container-lowest px-4 py-3 mb-5">
          <p className="text-xs text-muted-foreground mb-1">MCP server URL</p>
          <code className="text-sm text-foreground break-all">{MCP_URL}</code>
        </div>

        <Button type="button" variant="outline" onClick={() => void copyUrl()}>
          {copied ? <Check className="h-5 w-5 mr-2" /> : <Copy className="h-5 w-5 mr-2" />}
          {copied ? "Copied" : "Copy URL"}
        </Button>

        <ol className="mt-6 space-y-2 text-sm text-muted-foreground list-decimal list-inside">
          <li>
            In{" "}
            <a href="https://claude.ai/settings/connectors" className="text-primary hover:underline" target="_blank" rel="noreferrer">
              claude.ai → Settings → Connectors
            </a>
            , add a custom connector with the URL above.
          </li>
          <li>Approve access when prompted — you&apos;ll sign in to CareerVine if needed.</li>
          <li>
            In Claude Code:{" "}
            <code className="text-xs bg-surface-container-high px-1.5 py-0.5 rounded">
              claude mcp add --transport http careervine {MCP_URL}
            </code>
          </li>
        </ol>
      </CardContent>
    </Card>
  );
}
