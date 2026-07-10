// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import IntegrationsSection from "@/components/settings/integrations-section";

const mockGetGmailConnection = vi.fn();
const mockUseGmailConnection = vi.fn();

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { id: "user-1" } }),
}));

vi.mock("@/lib/queries", () => ({
  getGmailConnection: (...args: unknown[]) => mockGetGmailConnection(...args),
}));

vi.mock("@/hooks/use-gmail-connection", () => ({
  useGmailConnection: () => mockUseGmailConnection(),
  invalidateGmailConnectionCache: vi.fn(),
}));

vi.mock("@/components/settings/mcp-connect-card", () => ({
  default: () => <div data-testid="mcp-card" />,
}));

vi.mock("@/components/oauth-warning", () => ({
  OAuthWarning: () => null,
}));

function cardOrder() {
  const mcp = screen.getByTestId("mcp-card");
  const gmail = screen.getByRole("heading", { name: "Gmail" });
  // compareDocumentPosition: FOLLOWING bit set means the argument comes after the node.
  return mcp.compareDocumentPosition(gmail) & Node.DOCUMENT_POSITION_FOLLOWING
    ? "mcp-first"
    : "mcp-last";
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(cleanup);

describe("IntegrationsSection MCP card placement", () => {
  it("renders the MCP card below Gmail/Calendar when neither is connected", async () => {
    mockGetGmailConnection.mockResolvedValue(null);
    mockUseGmailConnection.mockReturnValue({ calendarConnected: false, calendarLastSynced: null, loading: false, refresh: vi.fn() });

    render(<IntegrationsSection />);
    await waitFor(() => expect(screen.getByText("Connect Gmail")).toBeTruthy());

    expect(cardOrder()).toBe("mcp-last");
  });

  it("renders the MCP card below when only Gmail is connected", async () => {
    mockGetGmailConnection.mockResolvedValue({ gmail_address: "d@x.com", last_gmail_sync_at: null });
    mockUseGmailConnection.mockReturnValue({ calendarConnected: false, calendarLastSynced: null, loading: false, refresh: vi.fn() });

    render(<IntegrationsSection />);
    await waitFor(() => expect(screen.getByText("d@x.com")).toBeTruthy());

    expect(cardOrder()).toBe("mcp-last");
  });

  it("renders the MCP card on top once Gmail and Calendar are both connected", async () => {
    mockGetGmailConnection.mockResolvedValue({ gmail_address: "d@x.com", last_gmail_sync_at: null });
    mockUseGmailConnection.mockReturnValue({ calendarConnected: true, calendarLastSynced: null, loading: false, refresh: vi.fn() });

    render(<IntegrationsSection />);
    await waitFor(() => expect(screen.getByText("d@x.com")).toBeTruthy());

    expect(cardOrder()).toBe("mcp-first");
  });
});
