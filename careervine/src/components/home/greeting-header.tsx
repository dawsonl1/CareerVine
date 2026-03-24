"use client";

import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";

interface GreetingHeaderProps {
  onLogConversation: () => void;
}

export function GreetingHeader({ onLogConversation }: GreetingHeaderProps) {
  return (
    <div className="flex items-center justify-end mb-6">
      <Button onClick={onLogConversation}>
        <Plus className="h-[18px] w-[18px]" /> Log conversation
      </Button>
    </div>
  );
}
