import { Search, Filter, RefreshCw, PenSquare, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Button } from "@/components/ui/button";

interface InboxTopBarProps {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  searchQuery: string;
  onSearchChange: (value: string) => void;
  onToggleFilters: () => void;
  activeFilterCount: number;
  syncing: boolean;
  onSync: () => void;
  onCompose: () => void;
}

/** Search field + filter toggle + sync + compose, above the sidebar/content row. */
export function InboxTopBar({
  sidebarOpen,
  onToggleSidebar,
  searchQuery,
  onSearchChange,
  onToggleFilters,
  activeFilterCount,
  syncing,
  onSync,
  onCompose,
}: InboxTopBarProps) {
  return (
    <div className="flex items-center gap-3.5 mb-5">
      {/* Sidebar toggle */}
      <button
        type="button"
        onClick={onToggleSidebar}
        className="hidden md:flex h-11 w-11 rounded-full items-center justify-center text-muted-foreground hover:text-foreground hover:bg-surface-container-low transition-colors cursor-pointer"
        title={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
      >
        {sidebarOpen ? <PanelLeftClose className="h-5 w-5" /> : <PanelLeftOpen className="h-5 w-5" />}
      </button>

      <div className="flex-1 relative">
        <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search emails..."
          className="w-full h-11 pl-11 pr-5 bg-surface-container-low text-foreground rounded-full border border-outline-variant placeholder:text-muted-foreground focus:outline-none focus:border-primary focus:border-2 transition-colors text-base"
        />
      </div>

      {/* Filter toggle */}
      <button
        type="button"
        onClick={onToggleFilters}
        className={`h-11 px-4 rounded-full flex items-center gap-2 text-base font-medium transition-colors cursor-pointer border ${
          activeFilterCount > 0
            ? "bg-primary-container text-on-primary-container border-primary/30"
            : "bg-surface-container-low text-muted-foreground border-outline-variant hover:text-foreground"
        }`}
      >
        <Filter className="h-4 w-4" />
        <span className="hidden sm:inline">Filters</span>
        {activeFilterCount > 0 && (
          <span className="min-w-[20px] h-[20px] px-1 flex items-center justify-center rounded-full bg-primary text-primary-foreground text-[11px] font-bold">
            {activeFilterCount}
          </span>
        )}
      </button>

      <button
        type="button"
        onClick={onSync}
        disabled={syncing}
        className="h-11 w-11 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-surface-container-low transition-colors cursor-pointer disabled:opacity-50"
        title="Sync emails"
      >
        <RefreshCw className={`h-5 w-5 ${syncing ? "animate-spin" : ""}`} />
      </button>
      <Button onClick={onCompose} size="sm">
        <PenSquare className="h-5 w-5 mr-2" />
        Compose
      </Button>
    </div>
  );
}
