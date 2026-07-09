"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Bot, Copy, Check } from "lucide-react";

const MCP_URL =
  `${process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "https://www.careervine.app"}/api/mcp`;

type ClientOption = "claude" | "claude-code" | "chatgpt" | "codex" | "cursor";

const CLIENT_OPTIONS: { id: ClientOption; label: string }[] = [
  { id: "claude", label: "Claude" },
  { id: "claude-code", label: "Claude Code CLI" },
  { id: "chatgpt", label: "ChatGPT" },
  { id: "codex", label: "Codex" },
  { id: "cursor", label: "Cursor" },
];

export default function McpConnectCard() {
  const [copied, setCopied] = useState(false);
  const [selectedClient, setSelectedClient] = useState<ClientOption>("claude");

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
          <h2 className="text-lg font-medium text-foreground">Connect an AI client</h2>
        </div>
        <p className="text-base text-muted-foreground mb-5">
          Connect CareerVine to your preferred assistant so it can use contacts, outreach queue,
          email drafts, and calendar data scoped to your account.
        </p>

        <div className="rounded-xl border border-outline bg-surface-container-lowest px-4 py-3 mb-5">
          <p className="text-xs text-muted-foreground mb-1">MCP server URL</p>
          <code className="text-sm text-foreground break-all">{MCP_URL}</code>
        </div>

        <Button type="button" variant="outline" onClick={() => void copyUrl()}>
          {copied ? <Check className="h-5 w-5 mr-2" /> : <Copy className="h-5 w-5 mr-2" />}
          {copied ? "Copied" : "Copy URL"}
        </Button>

        <div className="mt-6">
          <p className="text-xs text-muted-foreground mb-3">Choose your client</p>
          <div className="flex flex-wrap gap-2">
            {CLIENT_OPTIONS.map((option) => (
              <Button
                key={option.id}
                type="button"
                variant={selectedClient === option.id ? "default" : "outline"}
                size="sm"
                onClick={() => setSelectedClient(option.id)}
              >
                {option.label}
              </Button>
            ))}
          </div>
        </div>

        {selectedClient === "claude" && (
          <ol className="mt-5 space-y-2 text-sm text-muted-foreground list-decimal list-inside">
            <li>
              Open{" "}
              <a
                href="https://claude.ai/settings/connectors"
                className="text-primary hover:underline"
                target="_blank"
                rel="noreferrer"
              >
                claude.ai - Settings - Connectors
              </a>{" "}
              and add a custom connector with the URL above.
            </li>
            <li>Approve access when prompted. You may be asked to sign in to CareerVine.</li>
            <li>Start a new chat and enable the CareerVine connector for that conversation.</li>
          </ol>
        )}

        {selectedClient === "claude-code" && (
          <ol className="mt-5 space-y-2 text-sm text-muted-foreground list-decimal list-inside">
            <li>Run this command in your terminal:</li>
            <li>
              <code className="text-xs bg-surface-container-high px-1.5 py-0.5 rounded">
                claude mcp add --transport http careervine {MCP_URL}
              </code>
            </li>
            <li>If prompted, complete the auth flow and then start a new Claude Code session.</li>
          </ol>
        )}

        {selectedClient === "chatgpt" && (
          <ol className="mt-5 space-y-2 text-sm text-muted-foreground list-decimal list-inside">
            <li>
              In ChatGPT, open Settings - Apps &amp; Connectors, then enable Developer Mode in
              Advanced settings.
            </li>
            <li>Create a connector using the MCP URL above.</li>
            <li>Authorize CareerVine and enable the connector in your chat before using tools.</li>
          </ol>
        )}

        {selectedClient === "codex" && (
          <ol className="mt-5 space-y-2 text-sm text-muted-foreground list-decimal list-inside">
            <li>Codex supports custom MCP servers in both CLI and IDE extension.</li>
            <li>Run this command to add CareerVine:</li>
            <li>
              <code className="text-xs bg-surface-container-high px-1.5 py-0.5 rounded">
                codex mcp add careervine --url {MCP_URL}
              </code>
            </li>
            <li>
              If your Codex version requests it, run{" "}
              <code className="text-xs bg-surface-container-high px-1.5 py-0.5 rounded">
                codex mcp login careervine
              </code>{" "}
              to finish OAuth.
            </li>
          </ol>
        )}

        {selectedClient === "cursor" && (
          <ol className="mt-5 space-y-2 text-sm text-muted-foreground list-decimal list-inside">
            <li>Open Cursor settings and go to Tools &amp; MCP.</li>
            <li>Add a remote MCP server using the URL above, then complete authorization.</li>
            <li>
              You can also add it in{" "}
              <code className="text-xs bg-surface-container-high px-1.5 py-0.5 rounded">
                .cursor/mcp.json
              </code>{" "}
              with a URL-based server entry.
            </li>
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
