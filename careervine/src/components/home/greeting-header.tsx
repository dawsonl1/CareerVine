"use client";

import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";

interface GreetingHeaderProps {
  firstName: string;
  onLogConversation: () => void;
}

export function GreetingHeader({ firstName, onLogConversation }: GreetingHeaderProps) {
  return (
    <div className="flex items-center justify-between mb-8">
      <h1 className="text-[28px] leading-9 font-normal text-foreground">
        Hey, {firstName || "there"}
      </h1>
      <Button onClick={onLogConversation}>
        <Plus className="h-[18px] w-[18px]" /> Log conversation
      </Button>
    </div>
  );
}
