import type { SidebarItem, SidebarTab } from "./inbox-types";

interface NavProps {
  items: SidebarItem[];
  activeTab: SidebarTab;
  onSwitchTab: (key: SidebarTab) => void;
}

/** Desktop left sidebar (collapsible to an icon rail). */
export function InboxSidebar({ items, activeTab, onSwitchTab, sidebarOpen }: NavProps & { sidebarOpen: boolean }) {
  return (
    <div className={`shrink-0 hidden md:block transition-all duration-200 ${sidebarOpen ? "w-52" : "w-14"}`}>
      <nav className="space-y-1 sticky top-20">
        {items.map((item) => {
          const Icon = item.icon;
          const isActive = activeTab === item.key;
          const isBadge = item.key === "inbox" && item.count > 0;
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => onSwitchTab(item.key)}
              title={!sidebarOpen ? item.label : undefined}
              className={`w-full flex items-center gap-3.5 ${sidebarOpen ? "px-4" : "px-0 justify-center"} py-3 rounded-full text-base font-medium transition-colors cursor-pointer ${
                isActive ? "bg-secondary-container text-on-secondary-container" : "text-muted-foreground hover:text-foreground hover:bg-surface-container-low"
              }`}
            >
              <Icon className="h-5 w-5 shrink-0" />
              {sidebarOpen && (
                <>
                  <span className="flex-1 text-left">{item.label}</span>
                  {item.count > 0 && (
                    <span className={`text-sm font-medium ${
                      isBadge ? "bg-destructive text-destructive-foreground rounded-full min-w-[20px] h-[20px] px-1 flex items-center justify-center text-xs" : isActive ? "text-on-secondary-container" : "text-muted-foreground"
                    }`}>
                      {item.count}
                    </span>
                  )}
                </>
              )}
            </button>
          );
        })}
      </nav>
    </div>
  );
}

/** Horizontal tab strip shown in place of the sidebar on mobile. */
export function InboxMobileTabs({ items, activeTab, onSwitchTab }: NavProps) {
  return (
    <div className="flex md:hidden gap-1.5 border-b border-outline-variant mb-5 overflow-x-auto">
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          onClick={() => onSwitchTab(item.key)}
          className={`px-4 py-3 text-base font-medium transition-colors relative cursor-pointer whitespace-nowrap ${
            activeTab === item.key ? "text-primary" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {item.label}
          {item.count > 0 && ` (${item.count})`}
          {activeTab === item.key && <div className="absolute bottom-0 left-2 right-2 h-[3px] rounded-full bg-primary" />}
        </button>
      ))}
    </div>
  );
}
